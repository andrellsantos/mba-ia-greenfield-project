import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
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

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        ChannelsModule,
      ],
      providers: [StorageService, VideosService],
    }).compile();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    channelsService = module.get(ChannelsService);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
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
