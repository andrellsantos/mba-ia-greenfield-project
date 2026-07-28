import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${userCounter}`,
        nickname: `chan${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  it('should default status to draft when not provided', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My Video',
        storage_key: 'videos/some-id/original.mp4',
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should enforce title not null', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("channel_id", "storage_key") VALUES ($1, $2)`,
        [channel.id, 'videos/x/original.mp4'],
      ),
    ).rejects.toThrow();
  });

  it('should enforce FK constraint on channel_id', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          title: 'Orphan Video',
          storage_key: 'videos/orphan/original.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should allow null thumbnail_key, upload_id, duration_seconds, metadata and error_message', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My Video',
        storage_key: 'videos/some-id/original.mp4',
      }),
    );

    expect(video.thumbnail_key).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.error_message).toBeNull();
  });

  it('should persist and retrieve jsonb metadata', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My Video',
        storage_key: 'videos/some-id/original.mp4',
        metadata: { codec_name: 'h264', width: 1920, height: 1080 },
      }),
    );

    const found = await videoRepository.findOneBy({ id: video.id });
    expect(found?.metadata).toEqual({
      codec_name: 'h264',
      width: 1920,
      height: 1080,
    });
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My Video',
        storage_key: 'videos/some-id/original.mp4',
      }),
    );

    const found = await videoRepository.findOne({
      where: { channel_id: channel.id },
      relations: ['channel'],
    });

    expect(found?.channel.nickname).toBe(channel.nickname);
  });
});
