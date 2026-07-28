import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
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
import { VIDEO_PROCESSING_QUEUE, VIDEO_PROCESS_JOB } from './videos.constants';
import {
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoNotReadyException,
} from './exceptions/video.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videosService: VideosService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let queue: Queue;

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
      providers: [StorageService, VideosService],
    }).compile();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    channelsService = module.get(ChannelsService);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    storageService = module.get(StorageService);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain();
  });

  let userCounter = 0;
  async function createUserWithChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_svc_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);
    return { userId: user.id, channelId: channel.id };
  }

  describe('createDraft', () => {
    it('persists the draft with the returned upload_id', async () => {
      const { userId, channelId } = await createUserWithChannel();

      const result = await videosService.createDraft(
        userId,
        'Integration Video',
        'video/mp4',
        8 * 1024 * 1024,
      );

      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.upload_id).toBeTruthy();
      expect(result.parts.length).toBeGreaterThan(0);

      const persisted = await videoRepository.findOneBy({ id: result.id });
      expect(persisted).not.toBeNull();
      expect(persisted!.channel_id).toBe(channelId);
      expect(persisted!.status).toBe(VideoStatus.DRAFT);
      expect(persisted!.upload_id).toBe(result.upload_id);
      expect(persisted!.storage_key).toBe(`videos/${result.id}/original.mp4`);
    }, 15000);
  });

  describe('completeUpload', () => {
    async function createDraftVideo(userId: string): Promise<{
      id: string;
      uploadId: string;
      partUrl: string;
    }> {
      const draft = await videosService.createDraft(
        userId,
        'To Complete',
        'text/plain',
        5 * 1024 * 1024,
      );
      return {
        id: draft.id,
        uploadId: draft.upload_id,
        partUrl: draft.parts[0].url,
      };
    }

    it('completes the upload, transitions to processing, and enqueues exactly one job', async () => {
      const { userId } = await createUserWithChannel();
      const { id, partUrl } = await createDraftVideo(userId);

      const partBody = Buffer.from('a'.repeat(5 * 1024 * 1024));
      const uploadResponse = await fetch(partUrl, {
        method: 'PUT',
        body: partBody,
      });
      const etag = uploadResponse.headers.get('etag')!;

      const result = await videosService.completeUpload(userId, id, [
        { part_number: 1, etag },
      ]);

      expect(result).toEqual({ id, status: VideoStatus.PROCESSING });

      const persisted = await videoRepository.findOneBy({ id });
      expect(persisted!.status).toBe(VideoStatus.PROCESSING);
      expect(persisted!.upload_id).toBeNull();

      const jobs = await queue.getJobs(['waiting', 'active']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe(VIDEO_PROCESS_JOB);
      expect(jobs[0].data).toEqual({ videoId: id });
    }, 30000);

    it('throws VideoNotFoundException for a video owned by another channel', async () => {
      const { userId: ownerId } = await createUserWithChannel();
      const { userId: otherUserId } = await createUserWithChannel();
      const { id } = await createDraftVideo(ownerId);

      await expect(
        videosService.completeUpload(otherUserId, id, [
          { part_number: 1, etag: 'irrelevant' },
        ]),
      ).rejects.toThrow(VideoNotFoundException);
    }, 15000);

    it('throws VideoNotInDraftException when completed twice', async () => {
      const { userId } = await createUserWithChannel();
      const { id, partUrl } = await createDraftVideo(userId);

      const partBody = Buffer.from('a'.repeat(5 * 1024 * 1024));
      const uploadResponse = await fetch(partUrl, {
        method: 'PUT',
        body: partBody,
      });
      const etag = uploadResponse.headers.get('etag')!;
      await videosService.completeUpload(userId, id, [
        { part_number: 1, etag },
      ]);

      await expect(
        videosService.completeUpload(userId, id, [{ part_number: 1, etag }]),
      ).rejects.toThrow(VideoNotInDraftException);
    }, 30000);
  });

  describe('findOwnedById', () => {
    it('returns the video details for the owning channel', async () => {
      const { userId } = await createUserWithChannel();
      const draft = await videosService.createDraft(
        userId,
        'Details Video',
        'video/mp4',
        1024,
      );

      const details = await videosService.findOwnedById(userId, draft.id);

      expect(details.id).toBe(draft.id);
      expect(details.title).toBe('Details Video');
      expect(details.status).toBe(VideoStatus.DRAFT);
      expect(details.duration_seconds).toBeNull();
      expect(details.error_message).toBeNull();
    }, 15000);

    it('throws VideoNotFoundException for a video owned by another channel', async () => {
      const { userId: ownerId } = await createUserWithChannel();
      const { userId: otherUserId } = await createUserWithChannel();
      const draft = await videosService.createDraft(
        ownerId,
        'Details Video',
        'video/mp4',
        1024,
      );

      await expect(
        videosService.findOwnedById(otherUserId, draft.id),
      ).rejects.toThrow(VideoNotFoundException);
    }, 15000);
  });

  describe('getStreamableFile', () => {
    async function createReadyVideo(
      userId: string,
      content: Buffer,
    ): Promise<string> {
      const draft = await videosService.createDraft(
        userId,
        'Ready Video',
        'text/plain',
        content.length,
      );
      await storageService.putObject(
        `videos/${draft.id}/original.plain`,
        content,
        'text/plain',
      );
      await videoRepository.update(
        { id: draft.id },
        { status: VideoStatus.READY },
      );
      return draft.id;
    }

    it('returns the full file when no range is given', async () => {
      const { userId } = await createUserWithChannel();
      const content = Buffer.from('hello streamtube');
      const id = await createReadyVideo(userId, content);

      const result = await videosService.getStreamableFile(userId, id);

      const chunks: Buffer[] = [];
      for await (const chunk of result.body) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks).toString()).toBe('hello streamtube');
      expect(result.totalSize).toBe(content.length);
      expect(result.range).toBeUndefined();
      expect(result.filename).toBe('Ready Video.plain');
    }, 15000);

    it('returns a partial range when a Range header is given', async () => {
      const { userId } = await createUserWithChannel();
      const content = Buffer.from('0123456789');
      const id = await createReadyVideo(userId, content);

      const result = await videosService.getStreamableFile(
        userId,
        id,
        'bytes=0-3',
      );

      expect(result.range).toEqual({ start: 0, end: 3 });
    }, 15000);

    it('throws VideoNotReadyException when the video is not ready', async () => {
      const { userId } = await createUserWithChannel();
      const draft = await videosService.createDraft(
        userId,
        'Processing Video',
        'video/mp4',
        1024,
      );

      await expect(
        videosService.getStreamableFile(userId, draft.id),
      ).rejects.toThrow(VideoNotReadyException);
    }, 15000);

    it('throws VideoNotFoundException for a video owned by another channel', async () => {
      const { userId: ownerId } = await createUserWithChannel();
      const { userId: otherUserId } = await createUserWithChannel();
      const id = await createReadyVideo(ownerId, Buffer.from('x'));

      await expect(
        videosService.getStreamableFile(otherUserId, id),
      ).rejects.toThrow(VideoNotFoundException);
    }, 15000);
  });
});
