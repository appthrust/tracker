# Tracker

Tracker ("Issues" in the Marketplace) is AppThrust's Linear-style issue tracker:
report AppThrust defects with environment/surface/version context, triage them on a
keyboard-first list or board, and follow them to closure with comments, attachments and
a full activity timeline. A Go server serves the React SPA, the authenticated
`/api/tracker/v1` API, the shared app launcher, and `/healthz`, `/readyz`, and `/releasez`.
PostgreSQL stores application data. Directory (installed automatically as a dependency)
resolves people. The app is built and released independently of the platform.

Design: [`design/README.md`](design/README.md); API contract: [`design/API.md`](design/API.md).

## Source and layout

Skeleton derived from `appthrust/memo` (server wiring, SPA shell, publisher workflow);
module path `github.com/appthrust/tracker`.

- `cmd/server/` — Go server: `internal/domain` (pure rules), `internal/store` (pgstore +
  embedded SQL migrations), `internal/api` (handlers + `openapi.json`), `internal/directory`.
- `web/` — Vite + React + TanStack SPA, in-repo mock (`bun run mock`), tests.
- `catalog/entry.yaml` — the `ApplicationStackDefinition` the publisher submits.

The public Go SDK is `github.com/appthrust/appserver-go v0.3.0`; no platform checkout,
module replacement, or private Go credential is required. The launcher and i18n
packages use the published `^0.1.3` GitHub Packages versions rather than workspace
packages. Tailwind scans the installed launcher package for its classes.

## Develop

Use Go 1.26 or newer and Bun 1.4.1 (the CI and image version).

```sh
go build ./... && go test ./...
go vet ./...
cd web
# GitHub Packages requires a token with read:packages access.
export NODE_AUTH_TOKEN="$(gh auth token)"
bun install --frozen-lockfile
bun run typecheck
bun run build:image
```

For local UI development, run `bun run mock` and `bun run dev` in separate terminals
in `web/`. The mock defaults to port 5236 and Vite to port 5238. To use a real server,
set `TRACKER_API_UPSTREAM` plus `TRACKER_DEV_BEARER` or `TRACKER_DEV_COOKIE_FILE` as described in
`web/vite.config.ts`.

The mock gives Alex a same-origin Directory PNG avatar and leaves the other
people without photos. Avatars on cards, account rows, people pickers, reporter
properties and timeline entries use the same image/initials component.
Production avatar reads go through Tracker using the caller's existing bearer;
no Directory browser session is needed. Limits and caching are in
[`design/API.md`](design/API.md#directory-avatars-v014).

Run the server with `go run ./cmd/server --static-dir web/dist`. Configure:

- `PLATFORM_API_URL`, `PLATFORM_PROJECT_ID`, and the platform OIDC identity settings.
- `TRACKER_DATABASE_URL` (or `DATABASE_URL`) for PostgreSQL. `TRACKER_DEV_SEED=1` enables
  development seed data on an empty database: 42 issues, three closed one-week sprints
  with 18/21/24-point velocities, an active two-week sprint, a planned sprint, and
  four agents with live/stalled runs, review requests, answers and mentions.
- `TRACKER_PUBLIC_URL` for the HTTPS browser origin.
- `TRACKER_DIRECTORY_URL` and `TRACKER_DIRECTORY_PUBLIC_URL` for optional Directory links.
- `TRACKER_STATIC_DIR` or `--static-dir` to override `/srv/tracker`.

The database connection starts asynchronously. While connecting, `/readyz` is 503
and `/healthz` remains 200. Missing database configuration leaves the API returning
`tracker_store_unavailable` (503). `/api/tracker/v1/openapi.json` exposes the API document
when the API is available. `/releasez` uses `TRACKER_RELEASE_VERSION` and
`TRACKER_ARTIFACT_DIGEST` supplied by the catalog.

Sprint settings are workspace-wide: Admins can PATCH `sprintLengthWeeks` (1 or 2)
and an IANA `timezone` (default `Asia/Tokyo`). Any signed-in user can plan, start,
and close a sprint; only Admins can delete a planned sprint. Estimates are sizes
(`XS`, `S`, `M`, `L`, `XL`), worth 1/2/3/5/8 points. The server writes a
transactional ledger for burndown and velocity; closed ledgers never change.
On close, unfinished scope moves to the selected planned sprint or the backlog.
A lineage conflict in the destination sends that issue to the backlog.
Chart days follow the workspace timezone; ideal lines skip weekends, not holidays.
Sprint numbers are never reused after deletion.

A request whose bearer the server refuses (401 `unauthenticated`) writes one
`tracker auth rejected:` log line: method, path, the edge `X-Request-Id`, a
reason (`issuer`, `audience`, `expired_or_not_yet_valid`, `signature_or_keys`,
`claims_shape`, `malformed_jwt`, `missing_bearer`, `raw_access_key`, `other`),
and unverified token metadata (`alg`, `kid`, `iss`, `aud`, `azp`, `iat`, `nbf`,
`exp`, the JSON type of `groups`). It never contains the token, its signature,
or a personal claim. A 401 with no such line was answered by the edge.
The same 401 expires the edge's session cookies for this host
(`edge_cookies_expired=<n>` in the line), so the SPA's navigation to `/` runs a
real sign-in and receives a newly minted token instead of replaying the refused
one. The SSO session and other apps' sessions are not touched.

Scripts use an Access Key instead of a browser session: create a key in the
`tracker` space (`tracker:read`, `tracker:write`), exchange it with
`apth access-keys exchange`, and send the assertion as the bearer. User-subject
keys act as their user with the Viewer role. External-subject keys act as an
active registered agent whose immutable handle equals the subject.
The rules are in [`design/API.md`](design/API.md#access-keys-v0111).

### Agent protocol (0.1.14)

An agent registers itself: the first call of a new external-subject key is
`POST /api/tracker/v1/agents/register` with a display name, description and
its accountable person owner; the handle is the key's subject. Minting that
key needs a Project admin, which is the admission decision. The owner is
claimed by the agent, so the Agents page marks self-registered agents with the
key that registered them. An Admin can also register an agent directly through
`POST /api/tracker/v1/agents`. Keys are issued and revoked by the platform,
never by Tracker. Disabling an agent rejects all its keys (it cannot register
again), cancels its non-terminal runs and withdraws its open requests. Names
and owners may change; handles cannot. Existing issue attribution is not
rewritten. The rules are in
[`design/API.md`](design/API.md#self-registration-v0114).

Agents poll `/inbox` and `/events`. Initialize the event cursor without `after`,
then poll with `after=next`; sequence allocation and the represented write
commit together. Inbox assignments include Backlog and the agent's own live
run, which it should resume. A run has a ten-minute lease; stalled runs cannot
heartbeat or finish. A new start closes the expired run and its requests.

Completion defaults to `review`: successful finish opens a review to the
delegator (else owner); the person's approval completes the issue and updates
the sprint ledger. Admins may set `agentCompletion: "direct"` on the workspace
to allow agents to set completed statuses themselves. Finishing a run alone
never changes issue status. Agents may edit fields as assignee or reporter;
comments, attachments and questions/approvals can involve any issue.

`GET /api/tracker/v1/agent-guide` serves the full protocol as Markdown; its route
inventory uses the handler registration table. The public `openapi.json` includes
all agent shapes and routes. Mentions currently resolve registered `@handle`
agents only, not Directory people. Acknowledge answers by request ID and mentions
by comment ID through `/inbox/ack`; retained mentions preserve acknowledgement
when a comment is edited.

For safe retries, all JSON/non-multipart POST routes accept `Idempotency-Key`
(1–128 characters). Responses, including handler errors, are stored for 24 hours
per actor and key, atomically with successful writes. Replay requires identical
method, URI, content type and body bytes; a different request returns 409.
Authentication failures are not cached. Multipart attachment upload is excluded.
Use a fresh key for each new heartbeat. `PATCH /issues/{id}` accepts
`expectedUpdatedAt` and returns 409 when it no longer matches.

The real-server `hack/smoke.sh` also runs `hack/agents-smoke.sh` (signed assertion
fixture, isolated Postgres schema, no live services). With a disposable database:

```sh
DATABASE_URL='postgres://postgres:pg@127.0.0.1:55443/postgres?sslmode=disable' \
  /home/vagrant/.codex/skills/serialize-vm-tests/scripts/serialize-vm-tests -- bash hack/smoke.sh
```

The smoke verifies the collaboration loop, gap-free events for every semantic
write, replay/conflicts, mention acknowledgement, disabling and direct completion.
Both smoke scripts remove their schema, temporary files and processes on exit.

PostgreSQL integration tests are opt-in: they skip when both
`BUILTIN_APPSERVER_TEST_DATABASE_URL` and `BUILDER_CONSOLE_TEST_DATABASE_URL` are unset.
An explicitly configured test database must permit isolated schema creation.
Publisher renderer and mocked catalog API tests need no live services:

```sh
bun test hack/
```

Build the production image locally:

```sh
NODE_AUTH_TOKEN="$(gh auth token)" docker build --platform linux/amd64 \
  --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN -t tracker-local .
```

The image builds the SPA natively, cross-compiles the Go binary, and uses a
non-root distroless final stage. The executable is `/tracker-server`, static files are
in `/srv/tracker`, and port 8080 is exposed. Npm credentials enter the build only through
a required BuildKit secret, never through build arguments or committed files.

## Catalog and release

The next app release is **0.1.14**, also recorded in `web/package.json`.
`catalog/entry.yaml` carries no committed version: the first tag (`v0.1.0`)
created `versions[]` with `ghcr.io/appthrust/tracker@sha256:<index-digest>`,
stream `0.1`; later tags append at publication time. Do not add a version with
an unbuilt or placeholder image digest. OpenAPI's `info.version` describes the
API schema, not the app release. This repository has no hand-maintained changelog.

After the release prerequisites are available, push the SemVer tag `v0.1.14`.
The tag workflow:

1. Performs one multi-platform build on `ubuntu-24.04` for Linux amd64 and arm64,
   pushing `ghcr.io/appthrust/tracker:<version>`.
2. Resolves and signs the image index digest with Cosign keyless signing.
3. Reads Cloud's persisted entry, merges its history with the committed floor,
   and appends the new version using `ghcr.io/appthrust/tracker@sha256:<index-digest>`.
   The new version alone is default; earlier versions remain served. Reusing a
   version with different immutable images is rejected.
4. PUTs `/api/v1/catalog/entries/tracker`, then POSTs `/api/v1/catalog/publish`.
   HTTP 202 with state `queued` means Cloud dispatched publication; HTTP 200 with
   state `snapshot` requires the workflow to dispatch the Cloud repository event
   using a short-lived GitHub App installation token.
5. Waits up to ten minutes for the signed catalog artifact to contain the exact
   Tracker version and image digest. Dispatch alone is not publication success.

Publication commands used by the workflow:

```sh
bun hack/publish-entry.ts submit --version 0.1.14 --digest sha256:<image-index-digest>
bun hack/publish-entry.ts await --version 0.1.14 --digest sha256:<image-index-digest>
```

Writers are serialized by `tracker-catalog-publish`; the workflow is guarded to
`appthrust/tracker`. Required settings are repository secret `CLOUD_CATALOG_ADMIN_TOKEN`,
optional variable `CLOUD_API_URL` (default `https://api.appthrust.com`), and organization
secrets `APPTHRUST_GITHUB_ACTIONS_APP_ID` and `APPTHRUST_GITHUB_ACTIONS_APP_PRIVATE_KEY`.
The App must be installed on `appthrust/cloud` with Contents write permission.
GitHub Packages must grant this repository's `GITHUB_TOKEN` read access to
`@appthrust/app-launcher` and `@appthrust/platform-dashboard-i18n`. Make the GHCR image
public after its first publication.

`await` uses ORAS to verify the catalog index digest and Cosign to verify its signer:
`https://github.com/appthrust/cloud/.github/workflows/catalog-publish.yml@refs/heads/main`,
issued by `https://token.actions.githubusercontent.com`. It does not require the Cloud
admin token.

After publication, each estate's `AppCatalogSource` syncs the signed catalog.
Install Issues from the Project Marketplace (Directory is an automatic
dependency). Existing `follow` installations on stream `0.1` roll to the new
version; `pinned` installations show `UpdateAvailable` and require an explicit
version update. Confirm the installation is Ready, `/releasez` reports `0.1.14`,
the Project lists the `tracker` Access Key space as Ready, and an exchanged key reads `/api/tracker/v1/me`. These are release steps,
not actions performed by a source-only version bump.

Migration authority:
[First-party app repositories](https://github.com/appthrust/platform/blob/main/design/platform/marketplace-apps/first-party-app-repositories.md).
