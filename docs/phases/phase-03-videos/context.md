---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-28T07:44:45-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-28T10:39:38-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-28T07:44:45-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-28T07:44:45-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Interface de vídeo no frontend (player, telas de upload/gerenciamento) — a Fase 03 é um desafio de backend; o `next-frontend/` não é tocado. Edição de informações do vídeo, visibilidade pública/unlisted, painel de canal (Fase 04). Comentários, likes, inscrições (Fase 06). Página de visualização com sugestões (Fase 05).

**Deliverables:** Upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — nenhuma tela desta fase; a interface de vídeo é escopo de fases futuras (04/05).

**Sequencing notes:** Depends on Fase 01 (Configuração Base) e Fase 02 (Auth) — usa o canal do usuário (1:1, criado na Fase 02) como dono dos vídeos.

**Neighbors (for boundary detection only):**

- **Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior):** entrega a entidade `Channel` (1:1 com `User`) que a Fase 03 referencia como dono do vídeo.
- **Fase 04 — Gerenciamento de Vídeos e Canal (next):** edição de informações do vídeo, visibilidade, painel de canal — assume que a Fase 03 já entregou a entidade `videos` e o ciclo de status básico.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Tecnologia de fila | decided | A (BullMQ + Redis) | — _(fixed by plan-resolve)_ |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Estratégia de upload de 10GB | decided | A (Presigned multipart upload direto ao storage) | — _(fixed by plan-resolve)_ |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Worker e extração de metadados/thumbnail | decided | A (`fluent-ffmpeg` em container Node dedicado) | — _(fixed by plan-resolve)_ |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | URL única e streaming | decided | A (UUID da entidade + streaming proxiado com Range/206) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Ciclo de status e tratamento de falha | decided | A (4 estados, retry delegado à fila) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | _Given — S3/MinIO, não é decisão em aberto (ver TD-02 para como é usado: buckets/chaves/presigned)._ |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-05 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04 |
| Download do vídeo pelo usuário | phase-03-videos/TD-04 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — é o padrão de fato do ecossistema NestJS para jobs assíncronos, com integração oficial (`@nestjs/bullmq`) que já resolve retries, backoff e o padrão producer/consumer que a arquitetura-alvo exige. O custo de adicionar Redis ao Compose é baixo frente ao ganho de maturidade e observabilidade da fila.

**Libraries:** `@nestjs/bullmq`, `bullmq` _(versões a fixar via context7 em plan-resolve)_

### phase-03-videos/TD-02

**Recommendation:** Presigned multipart upload direto ao MinIO/S3 — remove o binário do caminho da API, evitando qualquer risco de travamento por arquivos de até 10GB; aproveita a API multipart nativa do MinIO (compatível com S3) sem exigir infraestrutura adicional.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` _(versões a fixar via context7 em plan-resolve)_

**Revisions:**
- 2026-07-28 — Bucket único (`streamtube-videos`) com chaves `videos/{videoId}/original.<ext>` e `videos/{videoId}/thumbnail.jpg`.

### phase-03-videos/TD-03

**Recommendation:** `fluent-ffmpeg` em container Node dedicado — resolve extração de metadados (`ffprobe()`) e geração de thumbnail (`screenshots()`) com uma API testada e concisa sobre o FFmpeg; mantém o worker como processo Node consistente com o resto do stack.

**Libraries:** `fluent-ffmpeg` _(+ binário `ffmpeg`/`ffprobe` na imagem Docker do worker; versão a fixar via context7 em plan-resolve)_

### phase-03-videos/TD-04

**Recommendation:** UUID da entidade como identificador público + streaming proxiado pela API com suporte a `Range`/`206 Partial Content` — opção mais simples de implementar corretamente (sem campo extra de unicidade) e mantém autorização centralizada na API a cada requisição.

**Libraries:** —

**Revisions:**
- 2026-07-28 — Download e streaming são o mesmo endpoint: sem `Range` → corpo completo + `Content-Disposition: attachment`; com `Range` → `206 Partial Content`.

### phase-03-videos/TD-05

**Recommendation:** 4 estados (`draft`, `processing`, `ready`, `error`), retry delegado à fila (BullMQ, TD-01) — atende ao requisito de ciclo de status sem duplicar o mecanismo de tentativas que a fila já resolve nativamente.

**Libraries:** —

**Revisions:**
- 2026-07-28 — Campo mínimo obrigatório no pré-cadastro (`draft`): apenas `title`. Descrição/categoria ficam para a Fase 04.

## Inherited Decisions Detail

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — formato `{ statusCode, error, message }` com códigos de domínio. Os novos erros da Fase 03 (ex.: vídeo não encontrado, upload inválido, conflito de URL) devem reutilizar este mesmo filtro e formato — não redefinir a forma da resposta de erro.

**Libraries:** —

### phase-01-configuracao-base/TD-03

**Recommendation:** Configuração namespaced/agrupada com `registerAs()` — um arquivo por domínio em `src/config/`. Os novos namespaces desta fase (storage/MinIO, fila/Redis) devem seguir o mesmo padrão (`storageConfig`, `queueConfig` via `registerAs`), não configuração ad-hoc.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Domain errors use a custom Domain Exception Filter returning `{ statusCode, error, message }` with `SCREAMING_SNAKE_CASE` domain codes — new error codes extend the same Error Catalog shape, not a new format. _(from phase 02)_
- JWT global guard (`APP_GUARD`) protects all routes by default; public endpoints opt out via `@Public()`. New video endpoints that must be reachable anonymously (streaming/watch, per Fase 05 forward-compat) need explicit `@Public()`. _(from phase 02)_
- Tests run against the real Docker `db` service, never mocked; integration/e2e suites share one database and require `--runInBand`. _(from phase 02, reinforced by CLAUDE.md project-wide rule)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/` (entities → integration; services with branching+DB → unit+integration; services with side-effect deps → integration against the real dependency; modules → unit compilation test; controllers/DTOs → E2E only).

**Resolved in `plan-resolve` (IC-1):** `testing-guide-nestjs-project/references/external-systems.md`'s Object Storage section was updated to document MinIO tested for real (via the Docker `storage` service), replacing the stale local-filesystem-in-tests guidance — consistent with TD-02 and the project's rule of not mocking what can be tested for real against the Compose infra. Message Queue strategy in the same file already anticipated "Real message broker in Docker... likely BullMQ with Redis" — consistent with TD-01, no change needed there.
