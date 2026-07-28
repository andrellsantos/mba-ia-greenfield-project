---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-28T10:40:23-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-28T10:39:38-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Testing guide documents local-filesystem storage strategy, contradicting TD-02 (real MinIO)"
    resolved_by: clarification
  - id: AMB-1
    status: resolved
    summary: "'Download do vídeo' bullet not distinguished from streaming in TD-04"
    resolved_by: phase-03-videos/TD-04
  - id: AMB-2
    status: resolved
    summary: "Required fields at draft/pre-registration creation time unspecified"
    resolved_by: phase-03-videos/TD-05
  - id: MD-1
    status: resolved
    summary: "Object storage bucket/key organization strategy not formally decided"
    resolved_by: phase-03-videos/TD-02
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._ Phase 03 depends on the `Channel` entity (1:1 with `User`), delivered and functional in Phase 02 — no gap. Within-phase ordering (storage/queue infra → upload endpoint → worker → streaming) has no undocumented dependency.

### Inherited Constraint Conflicts

_None._ Current-scope TDs (including the TD-02/TD-04/TD-05 revisions from this cycle) do not contradict inherited conventions or inherited TDs from Phases 01/02.

### Unresolved Open Questions

_None._ All 5 TDs in `## Decisions Index` are `decided` — no pending TD.

### UI Coverage Gaps

_None._ No UI scope in this phase (backend-only; `## UI Inventory` is absent from context.md by design).

## Resolved Issues

- **IC-1** _(resolved_by clarification)_ — Testing guide's Object Storage section updated to document real MinIO (tested for real via the Docker `storage` service), matching TD-02.
- **AMB-1** _(resolved_by phase-03-videos/TD-04)_ — Download and streaming are the same endpoint, distinguished by the `Range` header: absent → full body + `Content-Disposition: attachment`; present → `206 Partial Content`.
- **AMB-2** _(resolved_by phase-03-videos/TD-05)_ — Minimum required field to pre-register a draft video: `title` only. Description/category deferred to Phase 04.
- **MD-1** _(resolved_by phase-03-videos/TD-02)_ — Bucket/key organization fixed: single bucket (`streamtube-videos`) with keys `videos/{videoId}/original.<ext>` and `videos/{videoId}/thumbnail.jpg`.
