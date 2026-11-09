# Bug Tracker: implementation plan

Design: [README.md](./README.md). Repository: `appthrust/tracker` (new,
private until first publication like the other first-party apps). No
`appthrust/platform` change is required.

## Shared prerequisite (primary, committed first)

1. `gh repo create appthrust/tracker --private`; copy `appthrust/memo`
   skeleton: `go.mod` (module `github.com/appthrust/tracker`, require
   `appserver-go v0.2.0`), `Dockerfile`, `.github/workflows/{ci,publish}.yml`,
   `hack/` publisher renderer and its tests, `web/` tooling
   (`package.json`, `vite.config.ts`, `tsconfig`, Tailwind, i18n wiring).
   Rename every `memo`/`MEMO` occurrence to `tracker`/`TRACKER`.
2. Commit `catalog/entry.yaml` (README §Catalog entry) and
   `cmd/server/internal/api/openapi.json` as the **API contract** both
   workers implement against (paths, schemas, filter JSON, error codes).
3. Commit SQL migrations `001`–`006` (workspace, statuses, labels, issues +
   issue_labels + issue_links, comments + attachments + activity, views) so
   store and mock agree on shapes.

## Slices

| # | Slice | Owner | Files | Acceptance |
| --- | --- | --- | --- | --- |
| A | Domain + store: entities, transitions, identifier sequence, cycle check, `Can()`, filter → SQL, activity emission | `deep-worker` | `cmd/server/internal/{domain,store}` | `go test ./cmd/server/internal/...` green incl. opt-in Postgres tests; `pkg/decidetest`-style purity for `domain` |
| B | HTTP API + server wiring: handlers per `openapi.json`, directory people proxy, attachments streaming, pending/probes/config/releasez, dev seed | `deep-worker` | `cmd/server/{main,server}.go`, `internal/{api,directory}` | `go test ./cmd/server/...`; two-process smoke script in `hack/smoke.sh` passes against local Postgres |
| C | SPA: list/board/detail/report/settings, command palette, keyboard map, saved views, i18n ja/en, mock server covering `openapi.json` | `designer` | `web/src/**` | `bun run typecheck`, `bun test`, mock-driven browser walkthrough: file bug → comment → move on board → saved view |
| D | Publisher + first tag: verify `publish.yml` against Cloud catalog API, `v0.1.0`, Craftsman install and readback | primary | `.github/workflows/publish.yml`, tag | README §Verification readback items observed |

A and B share `internal/domain` types: B imports A's package; A owns it.
C depends only on `openapi.json`. D waits for A–C integrated and smoke green.

## Verification run once after integration (primary)

```sh
go vet ./... && go test ./...
(cd web && bun install --frozen-lockfile && bun run typecheck && bun test && bun run build:image)
bash hack/smoke.sh          # loopback server + local Postgres + curl flow
docker build --platform linux/amd64 --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN -t tracker-local .
```

Then tag `v0.1.0`, confirm `catalog-publish` reports `published`, install on
`pj-a167a047c8d3`, read back `/releasez` and file one real issue.
