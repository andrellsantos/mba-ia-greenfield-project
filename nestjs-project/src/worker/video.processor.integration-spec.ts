import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job, Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESS_JOB,
} from '../videos/videos.constants';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessor (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let videoProcessor: VideoProcessor;
  let storageService: StorageService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let fixturePath: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        ChannelsModule,
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            connection: { host: cfg.host, port: cfg.port },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [StorageService, VideoProcessor],
    }).compile();

    // `@nestjs/bullmq`'s Worker registration happens in an `onModuleInit`
    // hook (`BullRegistrar`) that only fires on the full app lifecycle —
    // a bare `.compile()` never calls it, so the real BullMQ Worker for
    // `VideoProcessor` would never actually start consuming jobs from the
    // queue. `createNestApplication()` + `init()` triggers that lifecycle.
    app = module.createNestApplication();
    await app.init();

    dataSource = module.get(DataSource);
    videoProcessor = module.get(VideoProcessor);
    storageService = module.get(StorageService);
    channelsService = module.get(ChannelsService);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    // Generates a tiny synthetic video (no external fixture file needed).
    fixturePath = path.join(os.tmpdir(), `fixture-${Date.now()}.mp4`);
    execFileSync('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=64x64:rate=5',
      '-y',
      fixturePath,
    ]);
  }, 30000);

  afterAll(async () => {
    await fs.promises.rm(fixturePath, { force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain();
  });

  let userCounter = 0;
  async function createDraftVideo(): Promise<string> {
    const user = await userRepository.save(
      userRepository.create({
        email: `processor_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Fixture Video',
        status: VideoStatus.PROCESSING,
        storage_key: `videos/${crypto.randomUUID()}/original.mp4`,
      }),
    );

    const content = await fs.promises.readFile(fixturePath);
    await storageService.putObject(video.storage_key, content, 'video/mp4');

    return video.id;
  }

  async function createDraftVideoWithInvalidFile(): Promise<string> {
    const user = await userRepository.save(
      userRepository.create({
        email: `processor_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Corrupted Fixture Video',
        status: VideoStatus.PROCESSING,
        storage_key: `videos/${crypto.randomUUID()}/original.mp4`,
      }),
    );

    await storageService.putObject(
      video.storage_key,
      Buffer.from('not a real video file'),
      'video/mp4',
    );

    return video.id;
  }

  async function waitForStatus(
    videoId: string,
    status: VideoStatus,
    timeoutMs = 20000,
  ): Promise<Video> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const video = await videoRepository.findOneBy({ id: videoId });
      if (video?.status === status) return video;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `Timed out waiting for video ${videoId} to reach status ${status}`,
    );
  }

  it('extracts duration/metadata, generates a thumbnail, and marks the video ready', async () => {
    const videoId = await createDraftVideo();
    const job = { data: { videoId } } as Job<{ videoId: string }>;

    await videoProcessor.process(job);

    const persisted = await videoRepository.findOneBy({ id: videoId });
    expect(persisted!.status).toBe(VideoStatus.READY);
    expect(persisted!.duration_seconds).toBeGreaterThan(0);
    expect(persisted!.metadata).not.toBeNull();
    expect(persisted!.thumbnail_key).toBe(`videos/${videoId}/thumbnail.jpg`);

    const thumbnail = await storageService.getObjectRange(
      persisted!.thumbnail_key!,
    );
    expect(thumbnail.totalSize).toBeGreaterThan(0);
  }, 30000);

  it('marks the video as error with the failure reason once retries are exhausted', async () => {
    const videoId = await createDraftVideoWithInvalidFile();

    await queue.add(
      VIDEO_PROCESS_JOB,
      { videoId },
      { attempts: 2, backoff: { type: 'fixed', delay: 100 } },
    );

    const persisted = await waitForStatus(videoId, VideoStatus.ERROR);
    expect(persisted.status).toBe(VideoStatus.ERROR);
    expect(persisted.error_message).toBeTruthy();
  }, 30000);
});
