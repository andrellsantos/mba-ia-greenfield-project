# phase-03-videos — Progress

**Status:** completed
**SIs:** 10/10 completed

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
- **Tests:** 4/4 passing (storage.service.integration-spec.ts) contra o MinIO real
- **Observations:**
  - Teste de multipart usa uma parte de 5MB (mínimo aceito pela API S3/MinIO para partes que não são a última) para validar o fluxo `createMultipartUpload` → presigned `UploadPartCommand` → PUT direto → `completeMultipartUpload` de ponta a ponta.
  - **Correção retroativa (encontrada durante a verificação final da fase, na Etapa de Fechamento):** o bucket `streamtube-videos` havia sido criado manualmente via `mc mb` nesta SI e nunca automatizado — em um `docker compose up -d` verdadeiramente do zero (volume do MinIO vazio, ex. checkout novo do repositório), nenhum código criava o bucket, e toda operação de storage falharia com `NoSuchBucket`. Isso é exatamente o risco do item de reprova automática "infra não sobe de verdade". Corrigido adicionando `OnModuleInit` ao `StorageService`: na inicialização, faz `HeadBucketCommand` e, se o bucket não existir, cria via `CreateBucketCommand`. Validado removendo o bucket manualmente e confirmando que o `worker` (que sobe automaticamente com `docker compose up -d`) o recria sozinho no boot, logando `Created storage bucket "streamtube-videos"`.
  - Novo teste de integração instancia um `StorageService` avulso (fora do DI, mesmo padrão de `databaseConfig()` usado em `data-source.ts`) apontando para um bucket descartável, chama `onModuleInit()` diretamente e confirma que o bucket é criado e utilizável — sem mexer no bucket compartilhado pelos demais testes.

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
- **Status:** completed
- **Tests:** no tests (infra) — verificado manualmente: `docker compose up -d --build worker` sobe saudável, `ffmpeg -version` funciona no container, log confirma "Video worker started, listening for jobs..."
- **Observations:**
  - **Decisão consciente divergente do padrão da API:** ao contrário do `nestjs-api` (que fica ocioso via `tail -f /dev/null` até o dev subir manualmente, por convenção do projeto), o `Dockerfile.worker` roda o processo de fato (`npm run worker:dev`) — o worker não é um servidor de desenvolvimento iterativo, é um processo de background cujo propósito inteiro é "processamento automático"; deixá-lo ocioso quebraria a fase (`docker compose up` não teria processamento algum funcionando de verdade).
  - **Bug pego ao subir o worker pela primeira vez:** `TypeORMError: Entity metadata for Channel#user was not found`. Causa: `Channel` tem uma relação `@OneToOne(() => User, ...)`, mas `WorkerModule` só importava `VideosModule` (que traz `ChannelsModule` transitivamente) — `User` nunca era registrado via `TypeOrmModule.forFeature` na árvore de módulos do worker, então o TypeORM não conseguia resolver a metadata da relação. Corrigido importando `UsersModule` diretamente em `WorkerModule`.
  - `worker:dev` usa `ts-node` (mesmo padrão do script `seed` já existente), evitando configurar múltiplos entry points no `nest-cli.json`. `worker:start:prod` (`node dist/worker/worker.main`) adicionado para produção, já que `nest build` compila toda a árvore de `src/`.

### SI-03.9 — Video Processor (metadados + thumbnail)
- **Status:** completed
- **Tests:** 1/1 novo passando (video.processor.integration-spec.ts, contra ffmpeg/ffprobe reais + MinIO real) + suíte completa revalidada (174 unit/integration + 64 e2e)
- **Observations:**
  - `ffmpeg` adicionado também ao `Dockerfile.dev` (imagem do `nestjs-api`) — necessário porque a convenção do projeto roda `npm test` dentro desse container, e o teste de integração do `VideoProcessor` invoca `ffmpeg`/`ffprobe` de verdade.
  - Teste gera um vídeo sintético minúsculo em tempo de execução via `ffmpeg -f lavfi -i testsrc=...` (sem fixture binária versionada no repo), evitando poluir o Git com um arquivo `.mp4`.
  - **Bug real corrigido:** coluna `duration_seconds` (`numeric` no Postgres) é retornada como `string` pelo driver `pg`, quebrando o contrato da API (`duration_seconds: number | null`). Corrigido com um `transformer` (`to`/`from`) no `@Column` da entidade `Video`, convertendo para `number` na leitura.
  - **Fricção de tipos do TypeORM resolvida:** `metadata: Record<string, unknown> | null` no payload de `.update()` não satisfaz estruturalmente o tipo mapeado `QueryDeepPartialEntity<Video>` (index signature genérica não é atribuível ao tipo específico esperado pelo TypeORM para colunas `jsonb`). Resolvido com um cast explícito `as QueryDeepPartialEntity<Video>` no próprio call site (import de `typeorm/query-builder/QueryPartialEntity`) — mantém o campo da entidade propriamente tipado para quem a lê, isolando o cast apenas onde o TypeORM exige.
  - `ffmpeg.ffprobe`'s callback error é tipado como `any` pela lib — `@typescript-eslint/prefer-promise-reject-errors` exige rejeitar com um `Error` de verdade; normalizado com `err instanceof Error ? err : new Error('ffprobe failed')`.

### SI-03.10 — Tratamento de Falha no Processamento
- **Status:** completed
- **Tests:** 1/1 novo passando (video.processor.integration-spec.ts, retry real via BullMQ contra Redis real) + suíte completa revalidada (175 unit/integration + 64 e2e)
- **Observations:**
  - **Bug real descoberto e corrigido, fora do escopo original desta SI:** o teste de retry-esgotado inicialmente não funcionava — o job ficava parado em `waiting` para sempre, mesmo com o worker "escutando". Investigação (via scripts ad-hoc dentro dos containers, descartados depois) revelou que `Test.createTestingModule().compile()` **não** dispara os hooks `onModuleInit`/`onApplicationBootstrap` — e é exatamente nesse hook que o `@nestjs/bullmq` registra o `Worker` real (`BullRegistrar.onModuleInit`). Sem `app.init()`, o `Queue` funciona normalmente (produtor), mas nenhum `Worker` de fato consome jobs. Corrigido chamando `module.createNestApplication()` + `app.init()` no teste, e `app.close()` no teardown — validando o ciclo real de retry/backoff do BullMQ, não uma simulação.
  - **Decisão de design:** `onFailed` só marca `status = error` quando `job.attemptsMade >= job.opts.attempts` (retries realmente esgotados) — falhas intermediárias são deixadas para o próprio mecanismo de retry/backoff da fila, sem duplicar essa lógica na aplicação (per `phase-03-videos/TD-01`, TD-05).
  - **Robustez adicionada:** o `.update()` dentro de `onFailed` está em `try/catch` com log via `Logger` — o BullMQ não captura exceções lançadas por listeners de evento (`worker.on('failed', ...)`), então uma falha nessa atualização (ex. instabilidade transitória do banco) derrubaria o processo inteiro do worker (via unhandled rejection), interrompendo o processamento de todos os vídeos, não só do job atual.
  - Teste usa `attempts: 2` com `backoff: { type: 'fixed', delay: 100 }` (mais rápido que a configuração de produção de `videos.service.ts`) apenas para manter o teste veloz — a config de produção (`attempts: 3`, backoff exponencial de 1s) não é alterada.
  - Durante a investigação, uma restauração acidental do Redis (comando de diagnóstico mal formado) e o restart do container `worker` foram necessários para recuperar o ambiente — sem perda de dados persistentes (fila e cache são efêmeros).
