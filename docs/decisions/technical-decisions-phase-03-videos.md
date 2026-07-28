---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-28
scope_description: "Fila de processamento, estratégia de upload de 10GB, worker de vídeo (FFmpeg), URL única/streaming e ciclo de status para a Fase 03 — Upload e Processamento de Vídeos"
---

# Technical Decisions — Fase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — recebe o módulo de vídeos, a infraestrutura nova no Compose (object storage, fila, worker) e a migration da tabela `videos`. Todas as decisões desta fase são aqui.
- `next-frontend/` — fora do escopo desta fase (enunciado da Fase 03: "desafio de backend"). Nenhuma decisão de UI é tomada neste documento.

---

## TD-01: Tecnologia de fila de processamento em segundo plano

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O `docs/project-plan.md` deixa a tecnologia de fila explicitamente em aberto ("Message Queue (TBD)" no `software-arch.mermaid`). É a única decisão de stack genuinamente aberta da fase — todo o resto (worker separado, object storage S3/MinIO) já está definido pela arquitetura-alvo. A escolha determina como a API enfileira o job de processamento após o upload e como o worker o consome.

**Options:**

### Option A: BullMQ + Redis
- Fila baseada em Redis, com wrapper oficial `@nestjs/bullmq` para registrar filas e processors via decorators (`@Processor`, `WorkerHost`, `@InjectQueue`). Suporta retries com backoff exponencial configurável por job ou por fila (`defaultJobOptions.attempts` + `backoff`), delayed jobs e eventos de ciclo de vida (`@OnWorkerEvent('failed' | 'completed')`).
- **Pros:** Integração oficial e madura com NestJS; documentação extensa; retries/backoff configuráveis nativamente; desempenho adequado para jobs pesados e de longa duração (processamento de vídeo); separação limpa entre API (producer) e worker (consumer) como a arquitetura já prevê.
- **Cons:** Introduz Redis como nova peça de infraestrutura no Compose (além de Postgres, Mailpit e o storage novo).

### Option B: pg-boss
- Fila implementada inteiramente sobre PostgreSQL (usa `SKIP LOCKED` para concorrência), sem infraestrutura adicional. Suporta `retryLimit`, `retryDelay` e `retryBackoff` (exponencial com jitter), e move jobs esgotados para uma fila de dead-letter.
- **Pros:** Zero infraestrutura nova além do Postgres já existente; modelo simples de operar; retries e dead-letter nativos.
- **Cons:** Sem wrapper oficial para NestJS (pacotes da comunidade como `nestjs-pgboss` não são mantidos pela equipe do NestJS); acopla a fila ao mesmo banco transacional da aplicação, competindo por I/O com as tabelas de domínio sob carga de upload simultâneo; ecossistema e comunidade menores que BullMQ para cargas de processamento de mídia.

### Option C: RabbitMQ
- Broker de mensageria dedicado (AMQP), integrável via `@nestjs/microservices` com transporte RMQ nativo do NestJS.
- **Pros:** Broker robusto e testado em produção, com garantias de entrega e roteamento avançado (exchanges, routing keys).
- **Cons:** Overhead operacional maior que Redis para o escopo do desafio (mais uma peça de infra sem necessidade de roteamento complexo); modelo de retries/backoff exige configuração manual mais verbosa que BullMQ; nenhuma vantagem concreta sobre BullMQ para uma fila simples de "processar vídeo após upload".

**Recommendation:** **Option A (BullMQ + Redis)** — é o padrão de fato do ecossistema NestJS para jobs assíncronos, com integração oficial (`@nestjs/bullmq`) que já resolve retries, backoff e o padrão producer/consumer que a arquitetura-alvo exige. O custo de adicionar Redis ao Compose é baixo (uma imagem leve, sem configuração complexa) frente ao ganho de maturidade e observabilidade da fila.

**Decision:** A — BullMQ + Redis

---

## TD-02: Estratégia de upload de vídeos de até 10GB sem travar a API

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** O plano do projeto exige que arquivos de até 10GB sejam enviados sem travar o sistema. Se o arquivo passar pelo processo da API (buffer em memória ou mesmo em stream via multipart/form-data tradicional), a API fica seguran-do a conexão pelo tempo inteiro do upload e concorre por recursos (memória, file descriptors, conexões HTTP) com o resto do tráfego. A decisão aqui é como o cliente envia o arquivo ao object storage sem que a API seja o intermediário do binário.

**Options:**

### Option A: Upload direto ao storage via presigned multipart upload (S3 multipart API)
- A API cria o registro do vídeo como rascunho e inicia um multipart upload no storage (`CreateMultipartUploadCommand`), calcula o número de partes pelo tamanho do arquivo, gera uma presigned URL por parte (`UploadPartCommand` + `getSignedUrl` do `@aws-sdk/s3-request-presigner`) e as devolve ao cliente. O cliente faz upload de cada parte diretamente ao storage (MinIO, compatível com a API S3); ao final, o cliente chama a API para completar o multipart upload (`CompleteMultipartUploadCommand`), que então enfileira o job de processamento.
- **Pros:** O binário nunca passa pela API — zero impacto em memória/conexões da API durante o envio; partes podem ser enviadas em paralelo pelo cliente; suporta retomada de partes individuais falhas sem reenviar o arquivo inteiro; é exatamente o padrão que o enunciado sugere ("upload direto ao storage via URL pré-assinada / multipart").
- **Cons:** Mais chamadas de API (iniciar, obter URLs por parte, completar) que um upload simples; exige que o cliente implemente a lógica de particionamento (ainda que fora do escopo desta fase, que é backend).

### Option B: Upload via streaming através da API (pipe direto para o storage, sem buffer)
- A API recebe o multipart/form-data e faz stream do corpo da requisição diretamente para o SDK do storage (`PutObjectCommand` com um stream), sem armazenar o arquivo inteiro em memória ou disco.
- **Pros:** Fluxo mais simples do ponto de vista do cliente (um único POST); nenhuma orquestração de partes.
- **Cons:** A API ainda segura a conexão HTTP pelo tempo inteiro do upload (10GB a uma conexão por vez), continua sendo um intermediário obrigatório e um ponto único de gargalo/timeout; não atende à exigência do enunciado de "sem passar o arquivo pela API de forma que trave o sistema" no espírito pretendido (o enunciado cita explicitamente upload pré-assinado/multipart como alternativa esperada).

### Option C: Protocolo resumable dedicado (tus)
- Um servidor tus (ex.: `tusd`) roda como serviço adicional no Compose, implementando o protocolo tus para uploads resumíveis em chunks; a API cria o registro de rascunho e delega o upload ao servidor tus.
- **Pros:** Retomada de upload robusta mesmo em falha de conexão a meio do envio de um chunk; protocolo padronizado e testado para uploads grandes.
- **Cons:** Introduz mais uma peça de infraestrutura (servidor tus) além de storage, fila e worker; exige um passo extra de integração (webhook do tus para acionar o pré-cadastro/pós-processamento) sem ganho adicional já que o storage escolhido (S3/MinIO) já oferece multipart upload nativo — a mesma garantia de retomada por parte é alcançável com a Option A sem novo componente.

**Recommendation:** **Option A (presigned multipart upload direto ao MinIO/S3)** — é a estratégia que efetivamente remove o binário do caminho da API, evitando qualquer risco de travamento por arquivos de até 10GB, aproveita a API multipart nativa do MinIO (compatível com S3) sem exigir infraestrutura adicional, e é a abordagem citada como esperada no próprio enunciado da fase.

**Decision:** A — Presigned multipart upload direto ao storage

---

## TD-03: Execução do worker e extração de metadados/thumbnail

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** A arquitetura-alvo já define um "Video Worker (FFmpeg)" como container separado que consome jobs da fila. A decisão em aberto é como esse worker é estruturado no código (processo Node dedicado dentro do monorepo, usando qual wrapper de FFmpeg) e como ele extrai duração/metadados e gera a thumbnail.

**Options:**

### Option A: Processo Node.js dedicado com `fluent-ffmpeg`, container próprio no Compose
- Um novo diretório/processo Node (consumidor BullMQ, conforme TD-01) roda em container separado com FFmpeg/FFprobe instalados na imagem. Usa `fluent-ffmpeg` para chamar `ffmpeg.ffprobe(path, callback)` (obtém `format.duration`, codecs, resolução) e `.screenshots({ timestamps: ['50%'], size, folder })` para gerar a thumbnail a partir de um frame.
- **Pros:** API fluente e bem documentada sobre o binário do FFmpeg; `ffprobe()` já retorna JSON estruturado com duração e metadados de stream; `screenshots()` resolve a geração de thumbnail em poucas linhas sem lidar manualmente com argumentos de linha de comando do FFmpeg.
- **Cons:** Mais uma dependência de terceiros (ainda que fina, é só um wrapper sobre o binário) — o próprio binário `ffmpeg`/`ffprobe` continua sendo instalado via imagem Docker.

### Option B: `child_process.spawn` direto do FFmpeg/FFprobe, sem wrapper
- O worker invoca os binários `ffmpeg`/`ffprobe` diretamente via `child_process`, parseando manualmente a saída (`ffprobe -print_format json`) e montando os argumentos de linha de comando para extrair um frame.
- **Pros:** Zero dependências além do Node padrão; controle total sobre os argumentos passados ao FFmpeg.
- **Cons:** Reimplementa manualmente o parsing de JSON do ffprobe e a montagem de argumentos de comando que `fluent-ffmpeg` já resolve testado e documentado; mais superfície de bugs (escaping de argumentos, tratamento de stderr/stdout) para um ganho que não se justifica no escopo do desafio.

### Option C: Serviço de transcodificação gerenciado na nuvem (ex.: AWS MediaConvert)
- Delega a extração de metadados e geração de thumbnail a um serviço externo gerenciado.
- **Pros:** Nenhuma manutenção de worker próprio; escalabilidade gerenciada pelo provedor.
- **Cons:** Contradiz a decisão já tomada de rodar o storage localmente via MinIO em Docker (o enunciado é explícito: MinIO local, trocaria por S3 em produção); introduz dependência de credenciais de nuvem e custo para um ambiente de desenvolvimento/desafio local; a arquitetura-alvo já define o worker como container próprio no Compose, não como serviço externo.

**Recommendation:** **Option A (`fluent-ffmpeg` em container Node dedicado)** — resolve extração de metadados e geração de thumbnail com uma API testada e concisa sobre o FFmpeg, mantém o worker como um processo Node consistente com o resto do stack (mesma linguagem/runtime da API e do módulo de vídeos), e é exatamente o componente "Video Worker (FFmpeg)" já previsto na arquitetura.

**Decision:** A — `fluent-ffmpeg` em container Node dedicado

---

## TD-04: Estratégia de URL única e de streaming

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos; Reprodução via streaming (sem necessidade de download completo)

**Context:** Cada vídeo precisa de um identificador público que nunca colida com outro, usado tanto para referenciar o vídeo (ex.: página de exibição, ainda que fora do escopo desta fase) quanto para o endpoint de streaming/download. A reprodução deve funcionar sem exigir o download completo do arquivo — isso implica suportar requisições HTTP com cabeçalho `Range` e responder `206 Partial Content`.

**Options:**

### Option A: UUID da própria entidade como identificador público + streaming proxiado pela API
- O `id` (uuid gerado pelo Postgres) do vídeo é o identificador da URL única. O endpoint de streaming lê o cabeçalho `Range` da requisição, calcula o intervalo de bytes, busca esse intervalo no storage (`GetObjectCommand` com `Range` no S3/MinIO) e repassa o stream de volta ao cliente com `206 Partial Content` e os cabeçalhos `Content-Range`/`Accept-Ranges`.
- **Pros:** Unicidade garantida pela própria PK (sem necessidade de gerar e checar colisão de um identificador adicional); toda a lógica de streaming fica centralizada na API, com controle total sobre autorização por vídeo antes de servir os bytes.
- **Cons:** A API atua como proxy de todo o tráfego de vídeo (banda e conexões da API escalam com o número de reproduções simultâneas), diferente do upload (que já evita esse gargalo via presigned URL).

### Option B: Slug curto dedicado (nanoid) + streaming via presigned GET URL (redirect para o storage)
- Um campo adicional (`public_id`, gerado com `nanoid` ou similar, curto e amigável para URL) identifica o vídeo publicamente. O endpoint de streaming não repassa os bytes: gera uma presigned GET URL (que o S3/MinIO já suporta nativamente com `Range`) e redireciona o cliente (`302`) ou retorna a URL para o player consumir diretamente do storage.
- **Pros:** Remove a API do caminho de dados durante a reprodução (o mesmo ganho que o upload pré-assinado trouxe para o envio); URLs mais curtas/amigáveis que um UUID.
- **Cons:** Introduz um campo extra a manter único (ainda que de baixa probabilidade de colisão com nanoid, exige constraint e checagem); o redirect delega o controle fino de autorização por requisição de range ao storage (a checagem de acesso acontece só na hora de gerar a presigned URL, não por chunk).

**Recommendation:** **Option A (UUID da entidade + streaming proxiado com suporte a `Range`/206)** — para o escopo desta fase, é a opção mais simples de implementar corretamente (sem campo adicional para gerenciar unicidade) e mantém a autorização por vídeo centralizada na API a cada requisição de streaming, o que é mais simples de testar e raciocinar sobre no nível de segurança do que uma presigned URL de vida curta. O custo de a API proxiar bytes de vídeo é aceitável no volume esperado do desafio; a decisão pode ser revisitada em uma fase futura se o volume de reprodução justificar mover para presigned GET.

**Decision:** A — UUID da entidade + streaming proxiado com Range/206

---

## TD-05: Ciclo de status do vídeo e tratamento de falha no processamento

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** O vídeo precisa de um ciclo de status observável no banco (rascunho → processando → pronto/erro), e é preciso definir o que acontece quando o processamento falha (ex.: arquivo corrompido, FFmpeg não consegue extrair metadados) — se há retry automático e quando o vídeo é definitivamente marcado como erro.

**Options:**

### Option A: Enum de 4 estados (`draft`, `processing`, `ready`, `error`), transição direta acionada pelos eventos da fila
- O vídeo nasce `draft` no pré-cadastro (antes do upload iniciar). Ao completar o multipart upload, a API enfileira o job e marca `processing`. O worker, ao terminar com sucesso, marca `ready` (com duração/metadados/thumbnail preenchidos); ao esgotar as tentativas de retry da própria fila (BullMQ `attempts` + `backoff`, TD-01), marca `error` com uma coluna `error_message` de texto livre para diagnóstico.
- **Pros:** Mapeamento direto e simples entre estado do job na fila e estado do vídeo no banco; reaproveita o mecanismo de retry já decidido em TD-01 em vez de duplicar lógica de tentativas na tabela de vídeos; suficiente para os requisitos explícitos da fase (não há requisito de vídeo "parcialmente processado" ou de reprocessamento manual nesta fase).
- **Cons:** Não expõe quantas tentativas já ocorreram diretamente na tabela de vídeos (fica no histórico da fila) — aceitável, pois não há requisito de exibir isso ao usuário nesta fase.

### Option B: Enum de 4 estados com contador de tentativas replicado na tabela de vídeos
- Mesmos 4 estados, mas a tabela de vídeos ganha uma coluna `processing_attempts` incrementada pelo worker a cada tentativa, permitindo consultar o histórico de tentativas sem consultar a fila.
- **Pros:** Observabilidade do número de tentativas diretamente via SQL, sem depender do estado interno do Redis/BullMQ.
- **Cons:** Duplica informação que a fila já mantém (dessincronização é possível se o worker falhar entre incrementar o contador e persistir o estado); nenhum requisito do enunciado pede esse nível de observabilidade nesta fase — é complexidade antecipada sem uso definido.

**Recommendation:** **Option A (4 estados, retry delegado à fila)** — atende exatamente o que o enunciado pede (ciclo de status refletido no banco + tratamento de falha) sem duplicar o mecanismo de retry que a fila já resolve de forma nativa e testada (TD-01). Simplicidade alinhada ao princípio de responsabilidade única: a fila controla tentativas, a tabela de vídeos reflete o estado final observável.

**Decision:** A — 4 estados, retry delegado à fila

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia de fila | BullMQ + Redis (Option A) | A (BullMQ + Redis) |
| TD-02 | Backend | Estratégia de upload de 10GB | Presigned multipart upload direto ao storage (Option A) | A (Presigned multipart upload) |
| TD-03 | Backend | Worker e extração de metadados/thumbnail | `fluent-ffmpeg` em container Node dedicado (Option A) | A (`fluent-ffmpeg` em container dedicado) |
| TD-04 | Backend | URL única e streaming | UUID da entidade + streaming proxiado com Range/206 (Option A) | A (UUID + streaming proxiado) |
| TD-05 | Backend | Ciclo de status e tratamento de falha | 4 estados, retry delegado à fila (Option A) | A (4 estados, retry na fila) |
