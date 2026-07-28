---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.4, SI-03.5, SI-03.6, SI-03.7
target_file: test/videos.e2e-spec.ts
---

# Videos Endpoints Test Plan

## Application Overview

O módulo de vídeos expõe quatro endpoints autenticados, todos restritos ao dono do canal: `POST /videos` (pré-cadastro do rascunho + início do multipart upload), `POST /videos/:id/complete-upload` (finaliza o upload e enfileira o processamento), `GET /videos/:id` (status e detalhes) e `GET /videos/:id/stream` (streaming/download via `Range`). Os testes rodam contra o Postgres e o MinIO reais do Compose — sem mocks de storage.

## Test Scenarios

### 1. POST /videos (pré-cadastro + início do upload)

**Setup:** `beforeEach` limpa as tabelas de vídeo/canal/usuário; bootstrap via `Test.createTestingModule({ imports: [AppModule] })` reproduzindo os pipes/filters globais do `main.ts`; usuário autenticado com canal já criado (fluxo de registro/login herdado da Fase 02).

#### 1.1. cria-rascunho-com-dados-validos

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-28T14:03:14Z

**Steps:**
  1. POST /videos com `{ title: "Meu Vídeo", content_type: "video/mp4", size_bytes: 10485760 }` e um access token válido
    - expect: 201
    - expect: body contém `{ id, title: "Meu Vídeo", status: "draft", upload_id, parts }` com `parts` não vazio, cada parte com `part_number` e `url`

#### 1.2. rejeita-arquivo-acima-de-10gb

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-28T14:03:14Z

**Steps:**
  1. POST /videos com `size_bytes` maior que 10GB (ex.: 10 * 1024^3 + 1)
    - expect: 400
    - expect: body de erro de validação (formato herdado da Fase 02)

#### 1.3. rejeita-sem-titulo

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-28T14:03:14Z

**Steps:**
  1. POST /videos sem o campo `title`
    - expect: 400
    - expect: body de erro de validação

---

### 2. POST /videos/:id/complete-upload (finaliza upload + enfileira processamento)

**Setup:** vídeo em `draft` criado via o fluxo do cenário 1.1 (upload_id + parts obtidos); as partes são de fato enviadas ao MinIO via as URLs assinadas antes de completar.

#### 2.1. completa-upload-com-partes-validas

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-28T14:03:14Z

**Steps:**
  1. Enviar cada parte (PUT) às URLs assinadas retornadas em 1.1, capturando os ETags
  2. POST /videos/:id/complete-upload com `{ parts: [{ part_number, etag }, ...] }`
    - expect: 200
    - expect: body contém `{ id, status: "processing" }`
    - expect: um job `video.process` com `{ videoId: id }` foi enfileirado na fila `video-processing`

#### 2.2. retorna-404-para-video-de-outro-canal

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-28T14:03:14Z

**Steps:**
  1. POST /videos/:id/complete-upload usando o `id` de um vídeo pertencente a outro canal
    - expect: 404
    - expect: `error: "VIDEO_NOT_FOUND"`

#### 2.3. retorna-409-quando-nao-esta-em-draft

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-28T14:03:14Z

**Steps:**
  1. Completar o upload de um vídeo uma primeira vez (cenário 2.1)
  2. POST /videos/:id/complete-upload novamente para o mesmo `id`
    - expect: 409
    - expect: `error: "VIDEO_NOT_IN_DRAFT"`

---

### 3. GET /videos/:id (status e detalhes)

**Setup:** vídeo existente pertencente ao canal do usuário autenticado (qualquer status).

#### 3.1. retorna-detalhes-do-dono

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-28T14:03:14Z

**Steps:**
  1. GET /videos/:id para um vídeo do próprio canal
    - expect: 200
    - expect: body contém `{ id, title, status, duration_seconds, error_message, created_at }`

#### 3.2. retorna-404-para-video-de-outro-canal

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-28T14:03:14Z

**Steps:**
  1. GET /videos/:id usando o `id` de um vídeo de outro canal
    - expect: 404
    - expect: `error: "VIDEO_NOT_FOUND"`

---

### 4. GET /videos/:id/stream (streaming e download via Range)

**Setup:** vídeo com `status: "ready"` e um objeto real gravado no MinIO em `storage_key` (seed direto via `StorageService.putObject` no teste, sem depender do worker rodar).

#### 4.1. download-sem-range-header

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-28T14:03:14Z

**Steps:**
  1. GET /videos/:id/stream sem header `Range`, vídeo `ready`
    - expect: 200
    - expect: header `Content-Disposition` contém `attachment`
    - expect: corpo da resposta igual ao arquivo original completo

#### 4.2. streaming-com-range-header

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-28T14:03:14Z

**Steps:**
  1. GET /videos/:id/stream com header `Range: bytes=0-99`, vídeo `ready`
    - expect: 206
    - expect: header `Content-Range` presente e correto
    - expect: corpo da resposta com exatamente 100 bytes

#### 4.3. retorna-409-quando-video-nao-esta-pronto

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-28T14:03:14Z

**Steps:**
  1. GET /videos/:id/stream para um vídeo com `status` diferente de `ready` (ex.: `processing`)
    - expect: 409
    - expect: `error: "VIDEO_NOT_READY"`

#### 4.4. retorna-404-para-video-de-outro-canal

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-28T14:03:14Z

**Steps:**
  1. GET /videos/:id/stream usando o `id` de um vídeo de outro canal
    - expect: 404
    - expect: `error: "VIDEO_NOT_FOUND"`
