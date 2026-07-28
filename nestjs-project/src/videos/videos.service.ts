import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService, PartUploadUrl } from './storage.service';
import { ChannelsService } from '../channels/channels.service';

const PART_SIZE_BYTES = 8 * 1024 * 1024; // 8MB per part

export interface CreateDraftResult {
  id: string;
  title: string;
  status: VideoStatus;
  upload_id: string;
  parts: PartUploadUrl[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly dataSource: DataSource,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
  ) {}

  async createDraft(
    userId: string,
    title: string,
    contentType: string,
    sizeBytes: number,
  ): Promise<CreateDraftResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`No channel found for user ${userId}`);
    }

    const id = crypto.randomUUID();
    const extension = contentType.split('/')[1] || 'bin';
    const storageKey = `videos/${id}/original.${extension}`;
    const partCount = Math.max(1, Math.ceil(sizeBytes / PART_SIZE_BYTES));

    return this.dataSource.transaction(async (manager) => {
      await manager.save(
        manager.create(Video, {
          id,
          channel_id: channel.id,
          title,
          status: VideoStatus.DRAFT,
          storage_key: storageKey,
        }),
      );

      const uploadId = await this.storageService.createMultipartUpload(
        storageKey,
        contentType,
      );
      const parts = await this.storageService.getPartUploadUrls(
        storageKey,
        uploadId,
        partCount,
      );

      await manager.update(Video, { id }, { upload_id: uploadId });

      return {
        id,
        title,
        status: VideoStatus.DRAFT,
        upload_id: uploadId,
        parts,
      };
    });
  }
}
