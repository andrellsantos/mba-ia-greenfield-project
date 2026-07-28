# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/10 completed

### SI-03.1 — Infra: Dependências, Config Namespaces, Docker Compose e Registro da Fila
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Criado `src/videos/videos.constants.ts` (VIDEO_PROCESSING_QUEUE, VIDEO_PROCESS_JOB) antecipadamente — necessário para o registro da fila em AppModule; o módulo de vídeos em si só é criado em SI-03.2.
  - Serviço `worker` do Compose propositalmente NÃO adicionado ainda — pertence a SI-03.8 (Dockerfile.worker ainda não existe).
  - Bucket `streamtube-videos` criado manualmente no MinIO via `mc mb` para viabilizar os testes de integração das próximas SIs.
  - DI wiring do BullModule verificado rodando a suíte e2e existente (52/52 passando) — sem teste dedicado nesta SI (infra).

### SI-03.2 — Entidade Video e Migration
- **Status:** completed
- **Tests:** 9/9 passing (video.entity.integration-spec: 6, videos.module.spec: 1, migrations.integration-spec: 2)
- **Observations:**
  - Estendido `migrations.integration-spec.ts` (Fase 02) para registrar `CreateVideos` e incluir `videos` em `MANAGED_TABLES` — sem isso, o teste dropava `channels` via CASCADE (FK de `videos`) e nunca recriava a tabela `videos`, quebrando todas as próximas SIs.
  - Corrigido deadlock: dropar `videos` (tem FK para `channels`) concorrentemente com `channels` via `Promise.all` causava deadlock entre duas conexões disputando o mesmo lock — `videos` agora é dropada sequencialmente antes do `Promise.all` do restante.
  - O segundo teste de `migrations.integration-spec.ts` foi re-semanticamente ajustado: `undoLastMigration()` agora reverte `CreateVideos` (última migration), não mais `CreateAuthTokens` — teste renomeado e reescrito para refletir isso.

### SI-03.3 — Storage Service (cliente S3/MinIO, multipart presigned, leitura por Range)
- **Status:** completed
- **Tests:** 3/3 passing (storage.service.integration-spec.ts) contra o MinIO real
- **Observations:**
  - Teste de multipart usa uma parte de 5MB (mínimo aceito pela API S3/MinIO para partes que não são a última) para validar o fluxo `createMultipartUpload` → presigned `UploadPartCommand` → PUT direto → `completeMultipartUpload` de ponta a ponta.
  - Bucket `streamtube-videos` já existia (criado manualmente em SI-03.1); nenhuma criação de bucket em código nesta fase.

### SI-03.4 — Endpoint POST /videos (pré-cadastro + início do upload)
- **Status:** completed
- **Tests:** 11/11 passing (videos.service.spec: 4, videos.service.integration-spec: 1, test/videos.e2e-spec.ts: 3) + suíte completa reverificada (161 unit/integration + 55 e2e)
- **Observations:**
  - Adicionado `ChannelsService.findByUserId` (com teste em `channels.service.integration-spec.ts`) — necessário para resolver o canal do usuário autenticado a partir do JWT (`JwtPayload` só carrega `sub`/`email`, não `channel_id`).
  - `cleanAllTables` (helper compartilhado) estendido para limpar `videos` de forma segura (bloco `DO $$ ... IF EXISTS ...`) — evita quebrar arquivos de teste que não incluem a entidade `Video` em runs onde a tabela ainda não existe, e evita violação de FK em arquivos que rodam depois de testes que criam vídeos.
  - `videos.module.spec.ts` (criado em SI-03.2) precisou de `ConfigModule` com `storageConfig` — o `StorageService` passou a ser registrado no módulo nesta SI.
  - Criado `test/videos.e2e-spec.ts` (via etapa JIT do `/plan-test-specs`) cobrindo o grupo 1 do spec (`POST /videos`); os grupos 2-4 serão adicionados incrementalmente pelas SIs 03.5-03.7, já que o projeto usa um arquivo E2E por recurso, não por endpoint.
  - `id` do vídeo é gerado em código (`crypto.randomUUID()`) antes do insert, não pelo default do banco — necessário para montar a `storage_key` (`videos/{id}/original.<ext>`) antes de persistir.

### SI-03.5 — Endpoint POST /videos/:id/complete-upload
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.6 — Endpoint GET /videos/:id
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.7 — Endpoint GET /videos/:id/stream
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.8 — Worker Bootstrap (contexto separado + Dockerfile + Compose)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.9 — Video Processor (metadados + thumbnail)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.10 — Tratamento de Falha no Processamento
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
