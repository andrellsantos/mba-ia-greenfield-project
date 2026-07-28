# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (stays idle by default — see "Environment Startup Verification" above)
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP test server, web UI on port `8025`
- `storage` — MinIO (S3-compatible), API on port `9000`, console on port `9001`, user/password `minioadmin`
- `redis` — Redis 7, port `6379`, backs the BullMQ video-processing queue
- `worker` — Video processing worker (`Dockerfile.worker`). Unlike `nestjs-api`, this container **runs its process automatically** on `docker compose up -d` — its only job is background processing, so leaving it idle would defeat the point of the queue

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Video Module (Phase 03)

`VideosModule` (`src/videos/`) implements upload, processing, and streaming of videos. It never accepts the video binary in an API request body — the 10GB size limit is handled entirely by uploading straight to object storage.

### Status lifecycle

`Video.status`: `draft → processing → ready | error`. Set by:
- `draft` — on `POST /videos` (only `title` is required at this point).
- `processing` — on `POST /videos/:id/complete-upload`, right after the queue job is enqueued.
- `ready` — set by the worker (`VideoProcessor.process`) once metadata/thumbnail extraction succeeds.
- `error` — set by `VideoProcessor.onFailed` (an `@OnWorkerEvent('failed')` handler) **only once BullMQ has exhausted all configured retry attempts** (`job.attemptsMade >= job.opts.attempts`), not on every individual failed attempt. Retries themselves are handled entirely by BullMQ's own `attempts`/`backoff` job options — there is no separate retry loop in application code.

### Endpoints (`VideosController`)

| Endpoint | Purpose |
|---|---|
| `POST /videos` | Creates a `draft` row + starts a presigned multipart upload; returns per-part presigned PUT URLs |
| `POST /videos/:id/complete-upload` | Completes the multipart upload, moves status to `processing`, enqueues the `video.process` job |
| `GET /videos/:id` | Returns status/details (owner-only) |
| `GET /videos/:id/stream` | Streams or downloads the file; the **same endpoint** serves both — presence of a `Range` header decides `206 Partial Content` (streaming) vs `200` with `Content-Disposition: attachment` (download). Requires `status: ready` |

All endpoints are owner-scoped: a user can only act on videos belonging to their own channel (resolved via `ChannelsService.findByUserId`, since the JWT payload only carries `sub`/`email`).

### Upload strategy

`StorageService` (S3-compatible client, `forcePathStyle: true` for MinIO) wraps presigned multipart upload: `createMultipartUpload` → one presigned `UploadPartCommand` URL per part → client uploads parts directly to storage → `completeMultipartUpload`. Objects live under `videos/{videoId}/original.<ext>` and `videos/{videoId}/thumbnail.jpg` in the `streamtube-videos` bucket (bucket name from `STORAGE_BUCKET`, default `streamtube-videos`).

`StorageService` implements `OnModuleInit` and ensures the bucket exists on boot (`HeadBucketCommand`, falling back to `CreateBucketCommand`) — this is required for a truly fresh environment (empty MinIO volume) to work without a manual `mc mb` step.

### Queue and worker

- Queue: BullMQ (`@nestjs/bullmq`), queue name `video-processing` (`VIDEO_PROCESSING_QUEUE` in `src/videos/videos.constants.ts`), job name `video.process`. Enqueued with `{ attempts: 3, backoff: { type: 'exponential', delay: 1000 } }` in `VideosService.completeUpload`.
- Worker: `src/worker/` is a **separate NestJS application context** (`worker.main.ts` → `NestFactory.createApplicationContext(WorkerModule)`, not the HTTP app), run via `npm run worker:dev` (`worker:start:prod` for the compiled build) in the `worker` Docker service. `VideoProcessor` (`@Processor(VIDEO_PROCESSING_QUEUE)`, extends `WorkerHost`) downloads the original file, runs `ffprobe` for metadata and `ffmpeg` (`.screenshots()`) for a thumbnail, uploads the thumbnail, and updates the `Video` row.
- `ffmpeg`/`ffprobe` (system binaries, via `fluent-ffmpeg`) are installed in **both** `Dockerfile.dev` (so `nestjs-api` — where `npm test` runs — can execute the worker's integration tests) and `Dockerfile.worker`.
- The `onFailed` handler's own DB update is wrapped in `try/catch`: BullMQ does not catch exceptions thrown from event listeners, so an unhandled rejection there would crash the entire worker process, not just the one job.

### Testing notes specific to this module

- `@nestjs/bullmq` registers the real BullMQ `Worker` in an `onModuleInit` hook (`BullRegistrar`) that only fires on the full Nest application lifecycle. A bare `Test.createTestingModule({...}).compile()` does **not** trigger it — a `Queue` producer still works (jobs can be enqueued), but no `Worker` will ever consume them. Any test that needs the real worker to process a real queued job must call `module.createNestApplication()` + `await app.init()` (see `video.processor.integration-spec.ts`), not just `.compile()`.
- `video.processor.integration-spec.ts` generates a tiny synthetic video on the fly via `execFileSync('ffmpeg', ['-f', 'lavfi', ...])` instead of committing a binary fixture to the repo.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
