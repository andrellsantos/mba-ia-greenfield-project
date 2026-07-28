import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import ffmpeg, { FfprobeData } from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';

interface VideoProcessJobData {
  videoId: string;
}

const THUMBNAIL_FILENAME = 'thumbnail.jpg';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneByOrFail({
      id: videoId,
    });

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'video-'));
    const extension = video.storage_key.split('.').pop();
    const originalPath = path.join(tempDir, `original.${extension}`);

    try {
      const { body } = await this.storageService.getObjectRange(
        video.storage_key,
      );
      await this.downloadToFile(body, originalPath);

      const metadata = await this.probe(originalPath);
      await this.generateThumbnail(originalPath, tempDir);

      const thumbnailKey = `videos/${videoId}/${THUMBNAIL_FILENAME}`;
      const thumbnailBuffer = await fs.promises.readFile(
        path.join(tempDir, THUMBNAIL_FILENAME),
      );
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        'image/jpeg',
      );

      // `metadata`'s Record<string, unknown> index signature doesn't structurally
      // satisfy TypeORM's QueryDeepPartialEntity mapped type — cast at the call
      // site only; the entity's own field stays properly typed for readers.
      await this.videoRepository.update({ id: videoId }, {
        status: VideoStatus.READY,
        duration_seconds: metadata.format.duration ?? null,
        metadata: metadata as unknown as Record<string, unknown>,
        thumbnail_key: thumbnailKey,
      } as QueryDeepPartialEntity<Video>);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;

    try {
      await this.videoRepository.update({ id: job.data.videoId }, {
        status: VideoStatus.ERROR,
        error_message: error.message,
      } as QueryDeepPartialEntity<Video>);
    } catch (updateError) {
      // BullMQ does not catch errors thrown from event listeners — an
      // unhandled rejection here would crash the whole worker process,
      // taking down every in-flight job, not just this one.
      this.logger.error(
        `Failed to mark video ${job.data.videoId} as error`,
        updateError instanceof Error ? updateError.stack : updateError,
      );
    }
  }

  private downloadToFile(stream: Readable, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(filePath);
      stream.pipe(writeStream);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
      stream.on('error', reject);
    });
  }

  private probe(filePath: string): Promise<FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err: unknown, data) => {
        if (err)
          reject(err instanceof Error ? err : new Error('ffprobe failed'));
        else resolve(data);
      });
    });
  }

  private generateThumbnail(filePath: string, folder: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .on('end', () => resolve())
        .on('error', reject)
        .screenshots({
          timestamps: ['50%'],
          filename: THUMBNAIL_FILENAME,
          folder,
        });
    });
  }
}
