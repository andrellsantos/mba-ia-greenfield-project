import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import storageConfig from '../config/storage.config';

export interface PartUploadUrl {
  part_number: number;
  url: string;
}

export interface CompletedPart {
  part_number: number;
  etag: string;
}

export interface ObjectRangeResult {
  body: Readable;
  contentType: string | undefined;
  contentLength: number;
  totalSize: number;
  range?: { start: number; end: number };
}

const PART_URL_EXPIRATION_SECONDS = 3600;

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY) cfg: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error('CreateMultipartUpload did not return an UploadId');
    }
    return result.UploadId;
  }

  async getPartUploadUrls(
    key: string,
    uploadId: string,
    partCount: number,
  ): Promise<PartUploadUrl[]> {
    const urls: PartUploadUrl[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: PART_URL_EXPIRATION_SECONDS },
      );
      urls.push({ part_number: partNumber, url });
    }
    return urls;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.part_number,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async getObjectRange(
    key: string,
    range?: string,
  ): Promise<ObjectRangeResult> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range && { Range: range }),
      }),
    );

    const body = result.Body as unknown as Readable;
    const contentLength = result.ContentLength ?? 0;

    if (result.ContentRange) {
      const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(result.ContentRange);
      if (match) {
        return {
          body,
          contentType: result.ContentType,
          contentLength,
          totalSize: parseInt(match[3], 10),
          range: { start: parseInt(match[1], 10), end: parseInt(match[2], 10) },
        };
      }
    }

    return {
      body,
      contentType: result.ContentType,
      contentLength,
      totalSize: contentLength,
    };
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }
}
