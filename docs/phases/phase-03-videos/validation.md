---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 4
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-28T10:33:43-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-28T10:31:24-03:00"
issues:
  - id: IC-1
    status: open
    summary: "Testing guide documents local-filesystem storage strategy, contradicting TD-02 (real MinIO)"
  - id: AMB-1
    status: open
    summary: "'Download do vídeo' bullet not distinguished from streaming in TD-04"
  - id: AMB-2
    status: open
    summary: "Required fields at draft/pre-registration creation time unspecified"
  - id: MD-1
    status: open
    summary: "Object storage bucket/key organization strategy not formally decided"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` documents the Object Storage test strategy as "Local filesystem storage in development and tests. S3 in production" — this contradicts `phase-03-videos/TD-02`, which decided that MinIO (S3-compatible, real) is the object storage for this environment, and the project-wide rule (CLAUDE.md / `nestjs-project/CLAUDE.md`) of testing against real Compose infra rather than mocking what can be tested for real. The Message Queue section of the same file already anticipates "Real message broker in Docker... likely BullMQ with Redis," consistent with TD-01 — only the Object Storage section is stale. Explicit choice: update the testing guide's Object Storage section to document MinIO as the real, tested-for-real dependency (analogous to PostgreSQL and Mailpit), removing the local-filesystem-in-tests guidance.

### Ambiguities

- **AMB-1** — The capability bullet "Download do vídeo pelo usuário" is not explicitly addressed by TD-04's recommendation, which focuses on streaming with `Range`/`206` support. It is unclear whether download is (a) the same streaming endpoint consumed without a `Range` header, relying on the client to save the response, or (b) a distinct endpoint/behavior that forces a full download via `Content-Disposition: attachment`. This affects the API Contracts to be written in `plan-build`. Explicit choice: clarify in TD-04 (or a short addendum) whether streaming and download are the same endpoint with different semantics based on request headers, or two distinct routes.
- **AMB-2** — The capability bullet "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" does not specify the minimum required input to create the draft (e.g., is `title` mandatory at creation time, or can the video be created with only a filename/size and have its title added later, in a future phase's edit flow?). This affects the request body of the "start upload" endpoint in `plan-build`'s API Contracts. Explicit choice: clarify the minimum required fields to pre-register a draft video.

### Missing Decisions

- **MD-1** — The capability "Serviço de armazenamento de arquivos (vídeos e thumbnails)" is covered as "given" (MinIO/S3, not an open decision) in `## Capability Coverage`, but the *organization* of buckets and keys — which `instructions.md` explicitly names as part of this phase's research scope ("o que você decide aqui é como usá-lo: organização de buckets/chaves, upload pré-assinado") — is not formally recorded anywhere in `TD-02`. `TD-02`'s recommendation covers the multipart upload mechanism but not the bucket/key naming convention. Explicit choice: extend `TD-02`'s recommendation (or add a short addendum) to specify bucket/key organization (e.g., single bucket with `videos/{id}/original.<ext>` and `videos/{id}/thumbnail.jpg` keys, vs. separate buckets per asset type).

### Dependency Gaps

_None._ Phase 03 depends on the `Channel` entity (1:1 with `User`), delivered and functional in Phase 02 — no gap. Within-phase ordering (storage/queue infra → upload endpoint → worker → streaming) has no undocumented dependency.

### Inherited Constraint Conflicts

_None._ Current-scope TDs do not contradict inherited conventions (config namespacing, Domain Exception Filter format, JWT global guard) or inherited TDs from Phases 01/02.

### Unresolved Open Questions

_None._ All 5 TDs in `## Decisions Index` are `decided` — no pending TD.

### UI Coverage Gaps

_None._ No UI scope in this phase (backend-only; `## UI Inventory` is absent from context.md by design).

## Resolved Issues

_No issues resolved yet._
