import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Readable } from 'stream';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  StorageService,
  PartUploadUrl,
  CompletedPart,
} from './storage.service';
import { ChannelsService } from '../channels/channels.service';
import {
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoNotReadyException,
} from './exceptions/video.exception';
import { VIDEO_PROCESSING_QUEUE, VIDEO_PROCESS_JOB } from './videos.constants';

interface S3ErrorLike {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

const PART_SIZE_BYTES = 8 * 1024 * 1024; // 8MB per part

export interface CreateDraftResult {
  id: string;
  title: string;
  status: VideoStatus;
  upload_id: string;
  parts: PartUploadUrl[];
}

export interface VideoDetails {
  id: string;
  title: string;
  status: VideoStatus;
  duration_seconds: number | null;
  error_message: string | null;
  created_at: Date;
}

export interface StreamableVideoFile {
  body: Readable;
  contentType: string | undefined;
  contentLength: number;
  totalSize: number;
  range?: { start: number; end: number };
  filename: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly dataSource: DataSource,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
  ) {}

  private async resolveOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`No channel found for user ${userId}`);
    }

    const video = await this.videoRepository.findOne({
      where: { id: videoId, channel_id: channel.id },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async findOwnedById(userId: string, videoId: string): Promise<VideoDetails> {
    const video = await this.resolveOwnedVideo(userId, videoId);
    return {
      id: video.id,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      error_message: video.error_message,
      created_at: video.created_at,
    };
  }

  async getStreamableFile(
    userId: string,
    videoId: string,
    range?: string,
  ): Promise<StreamableVideoFile> {
    const video = await this.resolveOwnedVideo(userId, videoId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    try {
      const result = await this.storageService.getObjectRange(
        video.storage_key,
        range,
      );
      const extension = video.storage_key.split('.').pop();
      return { ...result, filename: `${video.title}.${extension}` };
    } catch (err) {
      const e = err as S3ErrorLike;
      if (e.name === 'InvalidRange' || e.$metadata?.httpStatusCode === 416) {
        throw new HttpException(
          'Requested range not satisfiable',
          HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
        );
      }
      throw err;
    }
  }

  async completeUpload(
    userId: string,
    videoId: string,
    parts: CompletedPart[],
  ): Promise<{ id: string; status: VideoStatus }> {
    const video = await this.resolveOwnedVideo(userId, videoId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotInDraftException();
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.upload_id!,
      parts,
    );

    await this.videoRepository.update(
      { id: video.id },
      { status: VideoStatus.PROCESSING, upload_id: null },
    );

    await this.queue.add(
      VIDEO_PROCESS_JOB,
      { videoId: video.id },
      { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    );

    return { id: video.id, status: VideoStatus.PROCESSING };
  }

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
