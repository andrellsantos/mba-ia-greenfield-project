---
libs:
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-07-28T10:45:00-03:00"
  "bullmq":
    version: "^5.81.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-28T10:45:00-03:00"
  "ioredis":
    version: "^5.11.1"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-28T10:45:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1096.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-28T10:45:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1096.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-28T10:45:00-03:00"
  "fluent-ffmpeg":
    version: "^2.1.3"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-07-28T10:45:00-03:00"
  "@types/fluent-ffmpeg":
    version: "^2.1.28"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-07-28T10:45:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-28T10:39:38-03:00"
---

# phase-03-videos — Library References

Distilled docs excerpts fetched via context7, scoped to how each library is used by this phase's TDs. Full docs live upstream; this file caches only the surfaces the plan/implementation actually touches.

## `@nestjs/bullmq` (TD-01)

Official NestJS wrapper over BullMQ. Registration and consumption pattern:

```typescript
BullModule.forRootAsync({
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
  }),
  inject: [queueConfig.KEY],
}),
BullModule.registerQueue({ name: 'video-processing' }),
```

Consumer side — extend `WorkerHost`, implement `process(job)`, and use `@OnWorkerEvent` for lifecycle hooks (use `'failed'`, not `'completed'`, to drive the `error` status transition — TD-05):

```typescript
@Processor('video-processing')
class VideoProcessor extends WorkerHost {
  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    // extract metadata + thumbnail, update video status
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job) {
    // mark video as error after retries exhausted
  }
}
```

Producer side — inject the queue and enqueue with retry/backoff options (retries delegated to the queue per TD-05):

```typescript
constructor(@InjectQueue('video-processing') private queue: Queue) {}

await this.queue.add('process', { videoId }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
});
```

## `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (TD-02, TD-04)

**MinIO-compatible client config** (path-style required for MinIO):

```typescript
new S3Client({
  endpoint: cfg.endpoint, // e.g. http://storage:9000
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
```

**Multipart upload flow** (TD-02 — presigned per part):

```typescript
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }));

// one presigned URL per part, returned to the client
const url = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: n }),
  { expiresIn: 3600 },
);

// after the client uploads all parts and reports ETags:
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: completedParts }, // [{ PartNumber, ETag }]
}));
```

**Streaming/download** (TD-04 — same endpoint, `Range` header decides behavior): use `GetObjectCommand` with a `Range` parameter when the incoming request has one, and stream `Body` back with `206` + `Content-Range`; omit `Range` and set `Content-Disposition: attachment` for the download case.

## `fluent-ffmpeg` (+ `@types/fluent-ffmpeg`) (TD-03)

**Metadata extraction** (duration + stream info, TD-05's `processing → ready` transition data):

```typescript
ffmpeg.ffprobe(filePath, (err, data) => {
  const duration = data.format.duration; // seconds, string
  // data.streams[0] has codec/resolution when the stream is video
});
```

**Thumbnail generation** (single frame at 50% per this phase's implementation choice — not a formal TD, resolved at implement time):

```typescript
ffmpeg(filePath)
  .on('end', () => { /* thumbnail written */ })
  .screenshots({ timestamps: ['50%'], filename: 'thumbnail.jpg', folder: outputDir });
```

Note: the worker container's Dockerfile must install the `ffmpeg` binary (e.g., `apt-get install -y ffmpeg` on a Debian-based Node image) — `fluent-ffmpeg` is a wrapper, not a bundled binary.
