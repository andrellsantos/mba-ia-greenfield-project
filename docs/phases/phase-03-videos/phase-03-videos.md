---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-28T10:43:32-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-28T10:42:53-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-28T10:39:38-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload de vídeos de até 10GB via presigned multipart upload direto ao storage, processamento automático em fila (extração de metadados e thumbnail via worker FFmpeg), URL única por vídeo com streaming/download via Range requests, e o ciclo de status do vídeo (draft → processing → ready/error) refletido no banco.

---

## Step Implementations

### SI-03.1 — Infra: Dependências, Config Namespaces, Docker Compose e Registro da Fila

**Description:** Prepara a base da fase — dependências, configuração namespaced, infraestrutura nova no Compose (storage e fila) e o registro da fila BullMQ no `AppModule`, seguindo o padrão `registerAs()` já usado nas Fases 01/02.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3@^3.1096.0`, `@aws-sdk/s3-request-presigner@^3.1096.0`, `@nestjs/bullmq@^11.0.4`, `bullmq@^5.81.2`, `ioredis@^5.11.1`, `fluent-ffmpeg@^2.1.3`, `@types/fluent-ffmpeg@^2.1.28` (per `phase-03-videos/TD-01`, `TD-02`, `TD-03`).
2. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` via `registerAs()` (endpoint, region, accessKey, secretKey, bucket para storage; host, port para a fila) e estender `src/config/env.validation.ts` (Joi) com as novas variáveis.
3. Adicionar os serviços `storage` (MinIO, per `phase-03-videos/TD-02`) e `redis` (per `phase-03-videos/TD-01`) ao `compose.yaml`, com healthcheck para cada um.
4. Registrar `BullModule.forRootAsync` (conexão Redis via `queueConfig`) e `BullModule.registerQueue({ name: 'video-processing' })` no `AppModule`.
5. Adicionar as novas variáveis a `.env.example`.

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe os serviços `storage` e `redis` com healthcheck saudável, junto com `db`, `mailpit` e `nestjs-api`.
- A aplicação inicializa sem erro de DI com `BullModule` registrado (verificável via módulo de compilação de `AppModule`).

---

### SI-03.2 — Entidade Video e Migration

**Description:** Cria a entidade `Video` (ligada ao `Channel`) e a migration correspondente, seguindo o formato de `Channel`/`User` das Fases 01/02.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com o enum `VideoStatus` (`draft`, `processing`, `ready`, `error`) e os campos da Data Model (`channel_id`, `title`, `status`, `storage_key`, `thumbnail_key`, `upload_id`, `duration_seconds`, `metadata`, `error_message`, timestamps).
2. Gerar e commitar a migration `<timestamp>-CreateVideos.ts` (FK `channel_id` → `channels.id`, índice em `channel_id`).
3. Criar `VideosModule` com `TypeOrmModule.forFeature([Video])` e registrar em `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults (`status` default `draft`), FK to `Channel` | `video.entity.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `videos.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Migration cria a tabela `videos` com FK para `channels` e índice em `channel_id`.
- Inserir um `Video` sem `status` explícito persiste com `status = draft`.
- Inserir um `Video` com `channel_id` inexistente viola a constraint de FK.

---

### SI-03.3 — Storage Service (cliente S3/MinIO, multipart presigned, leitura por Range)

**Description:** Encapsula toda a interação com o object storage — cliente configurado para MinIO, criação de multipart upload com URLs assinadas por parte, finalização do upload e leitura de objeto por intervalo de bytes (para streaming/download).

**Technical actions:**

1. Criar `StorageService` com `S3Client` configurado via `storageConfig` (`endpoint`, `forcePathStyle: true`, `region`, `credentials`) (per `phase-03-videos/TD-02`, `@aws-sdk/client-s3`).
2. Implementar `createMultipartUpload(key, contentType)` + `getPartUploadUrls(key, uploadId, partCount)` usando `CreateMultipartUploadCommand` + `UploadPartCommand` com `getSignedUrl` de `@aws-sdk/s3-request-presigner`.
3. Implementar `completeMultipartUpload(key, uploadId, parts)` usando `CompleteMultipartUploadCommand`.
4. Implementar `getObjectRange(key, range?)` usando `GetObjectCommand` (com `Range` opcional) para servir streaming/download (per `phase-03-videos/TD-04`).
5. Implementar `putObject(key, body, contentType)` usando `PutObjectCommand` (upload direto, sem multipart) — usado pelo worker para enviar a thumbnail gerada (per `phase-03-videos/TD-03`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: contra o MinIO real do Compose — upload, multipart completo, leitura com e sem Range (per resolução IC-1 do guia de testes) | `storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (precisa de `storageConfig` e do serviço `storage` no Compose)

**Acceptance criteria:**

- `createMultipartUpload` + `getPartUploadUrls` retornam um `uploadId` e uma URL assinada por parte, válidas para PUT direto ao MinIO.
- `completeMultipartUpload` com as partes corretas resulta em um objeto recuperável no bucket configurado.
- `getObjectRange` sem `range` retorna o objeto completo; com `range` retorna somente o intervalo de bytes solicitado.
- `putObject` com um buffer pequeno resulta em um objeto recuperável na chave informada.

---

### SI-03.4 — Endpoint POST /videos (pré-cadastro do rascunho + início do upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Owner (channel do usuário autenticado)

**Description:** Cria o vídeo como rascunho (`status = draft`) vinculado ao canal do usuário autenticado e inicia o multipart upload no storage, retornando as URLs assinadas por parte para o cliente enviar o arquivo diretamente.

**Technical actions:**

1. Criar `CreateVideoDto` (`title`, `content_type`, `size_bytes`) com `class-validator` (per `phase-02-auth/TD-06`, herdado) — `size_bytes` limitado a 10GB.
2. Implementar `VideosController.create` — extrai o `channel_id` do usuário autenticado (via `@CurrentUser()`, herdado da Fase 02) e delega a `VideosService`.
3. Implementar `VideosService.createDraft` — cria o registro `Video` (`status = draft`, `storage_key = videos/{id}/original.<ext>` derivado da extensão de `content_type`) dentro de uma transação, chama `StorageService.createMultipartUpload` + `getPartUploadUrls`, persiste o `upload_id` retornado.
4. Calcular o número de partes a partir de `size_bytes` (tamanho de parte fixo, ex. 8MB) para gerar a quantidade correta de URLs assinadas.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createDraft` | Unit: branch logic (mock repo + mock StorageService) | `videos.service.spec.ts` |
| `VideosService.createDraft` | Integration: persistência do rascunho + `upload_id` | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (entidade `Video`), SI-03.3 (`StorageService`)

**Acceptance criteria:**

- `POST /videos` com `{title, content_type, size_bytes}` válidos retorna `201` com `{id, title, status: "draft", upload_id, parts}`.
- `POST /videos` com `size_bytes` acima de 10GB retorna `400` com erro de validação.
- `POST /videos` sem `title` retorna `400` com erro de validação.
- Criar o rascunho é atômico — se `StorageService.createMultipartUpload` falhar, nenhuma linha `Video` é persistida.

---

### SI-03.5 — Endpoint POST /videos/:id/complete-upload (finaliza upload + enfileira processamento)

**Route:** POST /videos/:id/complete-upload
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Owner (channel do usuário autenticado)

**Description:** Finaliza o multipart upload no storage a partir das partes enviadas pelo cliente, transiciona o vídeo para `processing` e enfileira o job de processamento (extração de metadados + thumbnail).

**Technical actions:**

1. Criar `CompleteUploadDto` (`parts: { part_number, etag }[]`) com `class-validator`.
2. Implementar `VideosController.completeUpload` — valida ownership (o `channel_id` do vídeo bate com o do usuário autenticado) e delega a `VideosService`.
3. Implementar `VideosService.completeUpload` — busca o vídeo por `id`, lança `VideoNotFoundException` (404) se não encontrado/não pertence ao canal, lança `VideoNotInDraftException` (409) se `status != draft`; chama `StorageService.completeMultipartUpload`; atualiza `status = processing`, limpa `upload_id`.
4. Enfileirar o job `video.process` (`{ videoId }`) na fila `video-processing` com `attempts` + `backoff` exponencial (per `phase-03-videos/TD-01`, Events/Messages).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: branch logic (not found, not-in-draft, happy path) | `videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: transição de status + job enfileirado (per o padrão de fila do testing guide) | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 (o vídeo precisa existir em `draft` com `upload_id`), SI-03.3 (`StorageService.completeMultipartUpload`), SI-03.1 (fila registrada)

**Acceptance criteria:**

- `POST /videos/:id/complete-upload` com partes válidas retorna `200` com `{id, status: "processing"}` e enfileira exatamente um job `video.process` com `{videoId: id}`.
- `POST /videos/:id/complete-upload` para um `:id` de outro canal retorna `404` com `VIDEO_NOT_FOUND`.
- `POST /videos/:id/complete-upload` quando o vídeo já não está em `draft` retorna `409` com `VIDEO_NOT_IN_DRAFT`.

---

### SI-03.6 — Endpoint GET /videos/:id (status e detalhes)

**Route:** GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Owner (channel do usuário autenticado)

**Description:** Expõe o estado atual do vídeo (status, duração, erro) para o dono do canal acompanhar o ciclo de processamento.

**Technical actions:**

1. Implementar `VideosController.findOne` — valida ownership e delega a `VideosService`.
2. Implementar `VideosService.findOwnedById` — busca por `id` + `channel_id`, lança `VideoNotFoundException` (404) se não encontrado.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwnedById` | Integration: retorno correto por dono, 404 para outro canal | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (entidade `Video`), SI-03.4 (vídeo precisa existir)

**Acceptance criteria:**

- `GET /videos/:id` do dono retorna `200` com `{id, title, status, duration_seconds, error_message, created_at}`.
- `GET /videos/:id` de um vídeo de outro canal retorna `404` com `VIDEO_NOT_FOUND`.

---

### SI-03.7 — Endpoint GET /videos/:id/stream (streaming e download via Range)

**Route:** GET /videos/:id/stream
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Owner (channel do usuário autenticado)

**Description:** Serve o arquivo do vídeo diretamente do storage — com `Range`, responde `206 Partial Content` para streaming; sem `Range`, responde o corpo completo com `Content-Disposition: attachment` para download (per `phase-03-videos/TD-04` revision).

**Technical actions:**

1. Implementar `VideosController.stream` — valida ownership, lança `VideoNotReadyException` (409) se `status != ready`, lê o header `Range` da requisição.
2. Implementar `VideosService.getStreamableFile` — chama `StorageService.getObjectRange(video.storage_key, range)` e retorna o stream + metadados (tamanho total, content-type).
3. No controller, montar a resposta: sem `Range` → `200` + `Content-Disposition: attachment` + stream completo; com `Range` válido → `206` + `Content-Range` + `Accept-Ranges: bytes` + stream parcial; com `Range` fora dos limites → `416`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamableFile` | Integration: leitura completa e por range contra o MinIO real | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (entidade `Video`), SI-03.3 (`StorageService.getObjectRange`)

**Acceptance criteria:**

- `GET /videos/:id/stream` sem `Range`, vídeo `ready`, retorna `200` com `Content-Disposition: attachment` e o corpo completo do arquivo.
- `GET /videos/:id/stream` com `Range: bytes=0-99`, vídeo `ready`, retorna `206` com `Content-Range` e os 100 primeiros bytes.
- `GET /videos/:id/stream` quando o vídeo não está `ready` retorna `409` com `VIDEO_NOT_READY`.
- `GET /videos/:id/stream` de um vídeo de outro canal retorna `404` com `VIDEO_NOT_FOUND`.

---

### SI-03.8 — Worker Bootstrap (contexto de aplicação separado + Dockerfile + Compose)

**Description:** Sobe o worker de vídeo como um processo Nest separado (application context, sem servidor HTTP), em container próprio com FFmpeg instalado, consumindo a mesma fila registrada em SI-03.1 (per `phase-03-videos/TD-03`).

**Technical actions:**

1. Criar `src/worker/worker.module.ts` importando `TypeOrmModule`/`ConfigModule`/`BullModule` (mesma configuração da API) e `VideosModule` (para acesso a `Video`/`StorageService`).
2. Criar `src/worker/worker.main.ts` com `NestFactory.createApplicationContext(WorkerModule)` (sem `app.listen`).
3. Criar `Dockerfile.worker` (a partir da mesma imagem base `node:25.6.0-slim`), instalando o binário `ffmpeg` via `apt-get install -y ffmpeg` e definindo o comando de start para `worker.main.ts`.
4. Adicionar o serviço `worker` ao `compose.yaml` (build via `Dockerfile.worker`, `depends_on: [db, redis, storage]`).

**Tests:** _(empty — Infra; o processador é testado em SI-03.9)_

**Dependencies:** SI-03.1 (fila registrada), SI-03.2 (entidade `Video`)

**Acceptance criteria:**

- `docker compose up -d` sobe o serviço `worker` com o binário `ffmpeg` disponível no container (`ffmpeg -version` executa com sucesso dentro do container).
- O processo do worker inicializa sem erro de DI e se conecta à mesma fila `video-processing` da API.

---

### SI-03.9 — Video Processor (extração de metadados + geração de thumbnail)

**Description:** Consome o job `video.process`: baixa o vídeo original do storage, extrai duração/metadados com `ffprobe`, gera uma thumbnail a partir de um frame com `ffmpeg`, envia a thumbnail ao storage e marca o vídeo como `ready`.

**Technical actions:**

1. Criar `VideoProcessor` (`@Processor('video-processing')`, `extends WorkerHost`) implementando `process(job)` (per `phase-03-videos/TD-01`, `@nestjs/bullmq`).
2. No `process(job)`: baixar o arquivo original via `StorageService.getObjectRange` (sem range) para um arquivo temporário; rodar `ffmpeg.ffprobe` para extrair `duration` e os dados de stream (per `phase-03-videos/TD-03`).
3. Gerar a thumbnail com `.screenshots({ timestamps: ['50%'], ... })` a partir do arquivo temporário; enviar o resultado ao storage em `videos/{id}/thumbnail.jpg` (via um método de upload do `StorageService`).
4. Atualizar o `Video`: `status = ready`, `duration_seconds`, `metadata` (dados do `ffprobe`), `thumbnail_key`; limpar o arquivo temporário.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration: processa um vídeo de teste real (fixture pequena) contra MinIO real, valida `duration_seconds`/`thumbnail_key`/`status` persistidos | `video.processor.integration-spec.ts` |

**Dependencies:** SI-03.3 (`StorageService`), SI-03.8 (worker bootstrap)

**Acceptance criteria:**

- Um job `video.process` para um vídeo `processing` com arquivo válido resulta em `status = ready`, `duration_seconds` preenchido, `metadata` preenchido e `thumbnail_key` apontando para um objeto existente no bucket.
- A thumbnail gerada corresponde a um frame do vídeo (arquivo de imagem válido, não vazio).

---

### SI-03.10 — Tratamento de Falha no Processamento (retry esgotado → status error)

**Description:** Quando o job `video.process` esgota as tentativas de retry configuradas na fila, marca o vídeo como `error` com o motivo da falha, encerrando o ciclo de status (per `phase-03-videos/TD-05`).

**Technical actions:**

1. No `VideoProcessor`, adicionar o handler `@OnWorkerEvent('failed')` — recebe o `job` já sem tentativas restantes (per `phase-03-videos/TD-01`, `bullmq`).
2. No handler, atualizar o `Video` correspondente (`job.data.videoId`): `status = error`, `error_message` com a mensagem do erro que causou a última falha.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration: força uma falha (ex. arquivo corrompido) e esgota as tentativas configuradas, verifica `status = error` e `error_message` preenchido | `video.processor.integration-spec.ts` |

**Dependencies:** SI-03.9 (o processador precisa existir para anexar o handler de falha)

**Acceptance criteria:**

- Um job `video.process` que falha em todas as tentativas configuradas resulta em `status = error` e `error_message` não vazio no `Video` correspondente.
- Um vídeo em `error` continua acessível via `GET /videos/:id` (SI-03.6), refletindo o estado e o motivo da falha.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated — public identifier used in the URL (per `phase-03-videos/TD-04`) |
| channel_id | uuid | FK → channels.id, not null |
| title | varchar(200) | not null (per `phase-03-videos/TD-05` revision — the only required field at draft creation) |
| status | enum(`draft`, `processing`, `ready`, `error`) | not null, default `draft` (per `phase-03-videos/TD-05`) |
| storage_key | varchar | not null — object key of the original file, e.g. `videos/{id}/original.<ext>` (per `phase-03-videos/TD-02` revision) |
| thumbnail_key | varchar | nullable — object key of the generated thumbnail, e.g. `videos/{id}/thumbnail.jpg`; set by the worker on success |
| upload_id | varchar | nullable — the storage provider's multipart UploadId; set on draft creation, cleared after `CompleteMultipartUpload` (per `phase-03-videos/TD-02`) |
| duration_seconds | numeric | nullable — set by the worker from `ffprobe`'s `format.duration` (per `phase-03-videos/TD-03`) |
| metadata | jsonb | nullable — raw `ffprobe` stream/format info captured by the worker (per `phase-03-videos/TD-03`) |
| error_message | text | nullable — set when `status = error` (per `phase-03-videos/TD-05`) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

**Relations:** `Video` belongs to `Channel` (many-to-one); `Channel` has many `Video`.
**Indexes:** index on `channel_id` (list videos by channel); no additional unique constraint beyond the PK — uniqueness of the public URL comes from `id` itself (per `phase-03-videos/TD-04`).

### API Contracts

#### POST /videos (SI-03.4)

**Request headers:**
- Authorization: Bearer <access_token> (required — endpoint is authenticated)
- Content-Type: application/json

**Request body:**
- title: string, required — min 1, max 200 characters (per `phase-03-videos/TD-05` revision)
- content_type: string, required — MIME type of the file being uploaded (e.g., `video/mp4`)
- size_bytes: number, required — total file size; used to compute the multipart part count; max 10GB (per `phase-03-videos/TD-02`)

**Response 201:**
- id: string (uuid)
- title: string
- status: string (`draft`)
- upload_id: string — the storage provider's multipart UploadId
- parts: array of `{ part_number: number, url: string }` — one presigned URL per part (per `phase-03-videos/TD-02`)

**Error responses:**
- 400 validation error: when the request body fails schema validation (missing title, invalid content_type, size_bytes exceeding 10GB)

---

#### POST /videos/:id/complete-upload (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token> (required)
- Content-Type: application/json

**Request body:**
- parts: array of `{ part_number: number, etag: string }`, required — the ETags returned by the storage provider for each uploaded part

**Response 200:**
- id: string (uuid)
- status: string (`processing`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `:id` does not match a video owned by the requester's channel
- 409 VIDEO_NOT_IN_DRAFT: when the video's status is not `draft` (upload already completed or in a later state)
- 400 validation error: when `parts` is missing or malformed

---

#### GET /videos/:id (SI-03.6)

**Request headers:**
- Authorization: Bearer <access_token> (required)

**Response 200:**
- id: string (uuid)
- title: string
- status: string (`draft` | `processing` | `ready` | `error`)
- duration_seconds: number | null
- error_message: string | null
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `:id` does not match a video owned by the requester's channel

---

#### GET /videos/:id/stream (SI-03.7)

**Request headers:**
- Authorization: Bearer <access_token> (required)
- Range: bytes=<start>-<end> (optional — presence decides streaming vs. download, per `phase-03-videos/TD-04` revision)

**Response 200:** Full file body, `Content-Disposition: attachment; filename="<title>.<ext>"` — returned when no `Range` header is present (download behavior).

**Response 206:** Partial file body, `Content-Range: bytes <start>-<end>/<total>`, `Accept-Ranges: bytes` — returned when a `Range` header is present (streaming behavior).

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `:id` does not match a video owned by the requester's channel
- 409 VIDEO_NOT_READY: when the video's status is not `ready` (nothing to stream/download yet)
- 416 requested range not satisfiable: when the `Range` header is out of bounds for the file size

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✗ | ✓ |
| POST /videos/:id/complete-upload | ✗ | ✗ | ✓ |
| GET /videos/:id | ✗ | ✗ | ✓ |
| GET /videos/:id/stream | ✗ | ✗ | ✓ |

_"Owner" means the video's `channel_id` matches the requesting user's channel — enforced at the service layer, not by a dedicated guard (per Phase 02's JWT global guard convention: all routes are authenticated by default via `APP_GUARD`; ownership is a service-level check, same pattern as `ChannelsService`)._

### Error Catalog

_Error response format inherited from Phase 02 (`{ statusCode, error, message }`, per `phase-02-auth/TD-07` — not redefined here)._

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `:id` does not match a video owned by the requester's channel, on any video endpoint |
| VIDEO_NOT_IN_DRAFT | 409 | `POST /videos/:id/complete-upload` when the video's status is not `draft` |
| VIDEO_NOT_READY | 409 | `GET /videos/:id/stream` when the video's status is not `ready` |

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-01`) — enqueued in `POST /videos/:id/complete-upload` (SI-03.5) right after `CompleteMultipartUpload` succeeds.
**Consumer:** `VideoProcessor` (worker, per `phase-03-videos/TD-01` + `phase-03-videos/TD-03`)
**Trigger:** Multipart upload completed successfully — the video is ready for metadata extraction and thumbnail generation.
**Delivery semantics:** at-least-once, with retry + exponential backoff configured on the queue (per `phase-03-videos/TD-01`); after retries are exhausted, the job's `'failed'` event marks the video `error` (per `phase-03-videos/TD-05`).

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root — infra: deps, config, compose, fila)
├── SI-03.3 — depends on SI-03.1 (storageConfig + serviço storage)
│   ├── SI-03.4 — depends on SI-03.2 + SI-03.3
│   │   └── SI-03.5 — depends on SI-03.4 + SI-03.3 + SI-03.1
│   ├── SI-03.7 — depends on SI-03.2 + SI-03.3
│   └── SI-03.9 — depends on SI-03.3 + SI-03.8
│       └── SI-03.10 — depends on SI-03.9
└── SI-03.8 — depends on SI-03.1 + SI-03.2

SI-03.2 (root — entidade Video e migration)
├── SI-03.4 (ver acima)
├── SI-03.6 — depends on SI-03.2 + SI-03.4
├── SI-03.7 (ver acima)
└── SI-03.8 (ver acima)
```

---

## Deliverables

- [x] SI-03.1 — Infra: Dependências, Config Namespaces, Docker Compose e Registro da Fila
- [x] SI-03.2 — Entidade Video e Migration
- [x] SI-03.3 — Storage Service (cliente S3/MinIO, multipart presigned, leitura por Range)
- [x] SI-03.4 — Endpoint POST /videos (pré-cadastro do rascunho + início do upload)
- [x] SI-03.5 — Endpoint POST /videos/:id/complete-upload (finaliza upload + enfileira processamento)
- [x] SI-03.6 — Endpoint GET /videos/:id (status e detalhes)
- [x] SI-03.7 — Endpoint GET /videos/:id/stream (streaming e download via Range)
- [x] SI-03.8 — Worker Bootstrap (contexto de aplicação separado + Dockerfile + Compose)
- [x] SI-03.9 — Video Processor (extração de metadados + geração de thumbnail)
- [x] SI-03.10 — Tratamento de Falha no Processamento (retry esgotado → status error)

**Full test suites:**

- [x] Suíte de testes passa (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [x] Testes E2E passam (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [x] Type-check passa (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passa (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [x] `docker compose up -d` sobe `db`, `mailpit`, `storage`, `redis`, `nestjs-api` e `worker` com healthcheck saudável em todos os serviços com healthcheck definido.
