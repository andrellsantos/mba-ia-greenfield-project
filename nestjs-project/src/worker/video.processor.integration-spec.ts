import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
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
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessor (integration)', () => {
  let dataSource: DataSource;
  let videoProcessor: VideoProcessor;
  let storageService: StorageService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let fixturePath: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        ChannelsModule,
      ],
      providers: [StorageService, VideoProcessor],
    }).compile();

    dataSource = module.get(DataSource);
    videoProcessor = module.get(VideoProcessor);
    storageService = module.get(StorageService);
    channelsService = module.get(ChannelsService);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);

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
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
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
});
