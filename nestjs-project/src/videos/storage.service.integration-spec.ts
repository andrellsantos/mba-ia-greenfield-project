import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as crypto from 'crypto';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let storageService: StorageService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();

    storageService = module.get(StorageService);
  });

  it('putObject then getObjectRange without range returns the full object', async () => {
    const key = `test-uploads/${crypto.randomUUID()}.txt`;
    const content = Buffer.from('hello streamtube');

    await storageService.putObject(key, content, 'text/plain');
    const result = await storageService.getObjectRange(key);

    const chunks: Buffer[] = [];
    for await (const chunk of result.body) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toBe('hello streamtube');
    expect(result.totalSize).toBe(content.length);
    expect(result.range).toBeUndefined();
  });

  it('getObjectRange with a Range header returns only the requested bytes', async () => {
    const key = `test-uploads/${crypto.randomUUID()}.txt`;
    const content = Buffer.from('0123456789');

    await storageService.putObject(key, content, 'text/plain');
    const result = await storageService.getObjectRange(key, 'bytes=0-3');

    const chunks: Buffer[] = [];
    for await (const chunk of result.body) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toBe('0123');
    expect(result.range).toEqual({ start: 0, end: 3 });
    expect(result.totalSize).toBe(content.length);
  });

  it('completes a multipart upload end-to-end via presigned part URLs', async () => {
    const key = `test-uploads/${crypto.randomUUID()}.txt`;
    const partBody = Buffer.from('a'.repeat(5 * 1024 * 1024)); // 5MB — S3 minimum part size

    const uploadId = await storageService.createMultipartUpload(
      key,
      'text/plain',
    );
    const [partUrl] = await storageService.getPartUploadUrls(key, uploadId, 1);

    const uploadResponse = await fetch(partUrl.url, {
      method: 'PUT',
      body: partBody,
    });
    expect(uploadResponse.ok).toBe(true);
    const etag = uploadResponse.headers.get('etag');
    expect(etag).toBeTruthy();

    await storageService.completeMultipartUpload(key, uploadId, [
      { part_number: 1, etag: etag! },
    ]);

    const result = await storageService.getObjectRange(key);
    expect(result.totalSize).toBe(partBody.length);
  }, 30000);

  it('onModuleInit creates the bucket automatically if it does not exist yet', async () => {
    const cfg = storageConfig();
    const throwawayBucket = `test-bucket-${crypto.randomUUID()}`;
    const freshService = new StorageService({
      ...cfg,
      bucket: throwawayBucket,
    });

    await freshService.onModuleInit();
    await freshService.putObject(
      'smoke-test.txt',
      Buffer.from('ok'),
      'text/plain',
    );
    const result = await freshService.getObjectRange('smoke-test.txt');
    expect(result.totalSize).toBeGreaterThan(0);

    const client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
    await client.send(
      new DeleteObjectCommand({
        Bucket: throwawayBucket,
        Key: 'smoke-test.txt',
      }),
    );
    await client.send(new DeleteBucketCommand({ Bucket: throwawayBucket }));
  }, 15000);
});
