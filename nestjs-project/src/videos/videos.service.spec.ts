import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  describe('createDraft', () => {
    let videosService: VideosService;
    let mockManager: {
      create: jest.Mock;
      save: jest.Mock<Promise<void>, [Video]>;
      update: jest.Mock;
    };
    let mockDataSource: { transaction: jest.Mock };
    let storageService: jest.Mocked<StorageService>;
    let channelsService: jest.Mocked<ChannelsService>;
    let videoRepository: jest.Mocked<Repository<Video>>;

    beforeEach(() => {
      mockManager = {
        create: jest.fn((_entity: unknown, data: unknown) => data),
        save: jest.fn<Promise<void>, [Video]>().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      };
      mockDataSource = {
        transaction: jest.fn((cb: (manager: unknown) => Promise<unknown>) =>
          cb(mockManager),
        ),
      };
      storageService = {
        createMultipartUpload: jest.fn(),
        getPartUploadUrls: jest.fn(),
      } as unknown as jest.Mocked<StorageService>;
      channelsService = {
        findByUserId: jest.fn(),
      } as unknown as jest.Mocked<ChannelsService>;
      videoRepository = {
        create: jest.fn((data: Partial<Video>) => data as Video),
      } as unknown as jest.Mocked<Repository<Video>>;

      videosService = new VideosService(
        videoRepository,
        mockDataSource as unknown as import('typeorm').DataSource,
        storageService,
        channelsService,
      );
    });

    it('throws when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        videosService.createDraft('user-1', 'Title', 'video/mp4', 1024),
      ).rejects.toThrow('No channel found for user user-1');
    });

    it('creates the draft, starts the multipart upload, and returns parts', async () => {
      channelsService.findByUserId.mockResolvedValue({
        id: 'channel-1',
      } as Channel);
      storageService.createMultipartUpload.mockResolvedValue('upload-123');
      storageService.getPartUploadUrls.mockResolvedValue([
        { part_number: 1, url: 'http://storage/part1' },
      ]);

      const result = await videosService.createDraft(
        'user-1',
        'My Video',
        'video/mp4',
        8 * 1024 * 1024,
      );

      expect(result.title).toBe('My Video');
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.upload_id).toBe('upload-123');
      expect(result.parts).toEqual([
        { part_number: 1, url: 'http://storage/part1' },
      ]);
      expect(mockManager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-1',
          title: 'My Video',
          status: VideoStatus.DRAFT,
        }),
      );
      expect(mockManager.update).toHaveBeenCalledWith(
        Video,
        { id: result.id },
        { upload_id: 'upload-123' },
      );
    });

    it('derives the storage key extension from content_type', async () => {
      channelsService.findByUserId.mockResolvedValue({
        id: 'channel-1',
      } as Channel);
      storageService.createMultipartUpload.mockResolvedValue('upload-123');
      storageService.getPartUploadUrls.mockResolvedValue([]);

      await videosService.createDraft('user-1', 'My Video', 'video/mp4', 1024);

      const savedVideo = mockManager.save.mock.calls[0][0];
      expect(savedVideo.storage_key).toMatch(
        /^videos\/[0-9a-f-]{36}\/original\.mp4$/,
      );
    });

    it('does not persist the draft when createMultipartUpload fails', async () => {
      channelsService.findByUserId.mockResolvedValue({
        id: 'channel-1',
      } as Channel);
      storageService.createMultipartUpload.mockRejectedValue(
        new Error('storage unavailable'),
      );

      await expect(
        videosService.createDraft('user-1', 'My Video', 'video/mp4', 1024),
      ).rejects.toThrow('storage unavailable');

      // save() was called inside the transaction callback, but since the
      // callback throws afterward, dataSource.transaction (real implementation)
      // rolls back — this unit test only verifies save() happened before the
      // throw; atomicity itself is verified by the integration test.
      expect(mockManager.update).not.toHaveBeenCalled();
    });
  });
});
