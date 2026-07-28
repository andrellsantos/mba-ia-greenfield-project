# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 7/10 completed

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
- **Status:** completed
- **Tests:** 12/12 novos passando (videos.service.spec: +3, videos.service.integration-spec: +3, videos.e2e-spec: +3) + suíte completa revalidada
- **Observations:**
  - **Correção crítica de infraestrutura de testes:** `npm test` e `npm run test:e2e` (package.json) não tinham `--runInBand`, apesar do CLAUDE.md afirmar que já vinha configurado e da regra do projeto de que suítes e2e/integration compartilham um único banco e precisam rodar sequencialmente. Isso é uma condição de corrida latente desde as Fases 01/02 (arquivos rodavam em workers paralelos do Jest contra o mesmo Postgres); só se manifestou agora porque `videos.e2e-spec.ts` é mais lento (chamadas reais ao MinIO), aumentando a janela de colisão. Corrigido adicionando `--runInBand` a ambos os scripts — suíte completa revalidada 2x sem flakiness após a correção.
  - Criadas as exceções de domínio `VideoNotFoundException` (404) e `VideoNotInDraftException` (409) em `src/videos/exceptions/video.exception.ts`, reaproveitando o `DomainExceptionFilter` já registrado globalmente (Fase 02) — nenhuma mudança no filtro foi necessária.
  - `VideosModule` precisou de `BullModule.registerQueue` próprio (além do registro em `AppModule`) para que `@InjectQueue` funcione no escopo do módulo — padrão do `@nestjs/bullmq` (cada módulo que injeta uma fila precisa registrá-la localmente).
  - Endpoint retorna `200` (não `201`) via `@HttpCode(HttpStatus.OK)` — NestJS assume `201` para `@Post()` por padrão.

### SI-03.6 — Endpoint GET /videos/:id
- **Status:** completed
- **Tests:** 4/4 novos passando (videos.service.integration-spec: +2, videos.e2e-spec: +2) + suíte completa revalidada (169 unit/integration + 60 e2e)
- **Observations:**
  - Reaproveitou o `resolveOwnedVideo` privado já criado em SI-03.5 — nenhuma lógica de ownership duplicada.

### SI-03.7 — Endpoint GET /videos/:id/stream
- **Status:** completed
- **Tests:** 16/16 novos passando (videos.service.integration-spec: +4, videos.e2e-spec: +4, mais os testes de `getObjectRange`/`putObject` já cobertos em SI-03.3) + suíte completa revalidada (173 unit/integration + 64 e2e)
- **Observations:**
  - Controller usa `@Res() res: Response` (Express cru) para poder setar `Content-Range`/`Accept-Ranges`/`Content-Disposition` e status 200/206 dinamicamente — o `DomainExceptionFilter` global continua funcionando normalmente pois as exceções são lançadas no service, antes de qualquer escrita em `res`.
  - 416 (`Requested range not satisfiable`) mapeado a partir do erro `InvalidRange` do SDK S3, via `HttpException` padrão do Nest (não é um domain error — não tem `errorCode`, conforme o Error Catalog do plano).
  - Bug pego durante os testes: a chave de storage é derivada da extensão do `content_type` (`text/plain` → `.plain`, não `.mp4`) — corrigido nos helpers de teste que gravavam o objeto de teste na chave errada.
  - Vídeo "pronto" para os testes é semeado diretamente (grava objeto via `StorageService.putObject` + atualiza `status` no banco), sem depender do worker (ainda não implementado — SI-03.8/03.9).

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
