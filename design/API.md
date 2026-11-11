# Tracker API contract (`/api/tracker/v1`)

Authoritative for both the Go server (`cmd/server/internal/api`, which also
emits `openapi.json` from these shapes) and the SPA mock
(`web/src/dev/mock-tracker.ts`). Change this file first.

Conventions (SDK `httpx`): success bodies are the resource or
`{ "items": [...], "nextCursor": string|null }`; errors are
`{ "error": "<code>", "message": "...", "issues"?: [{path, message}] }` with
codes `invalid` (400), `unauthenticated` (401), `raw_key_not_accepted` (401),
`forbidden` (403), `insufficient_scope` (403), `key_subject` (403),
`not_found` (404), `conflict` (409), `directory_avatar_unavailable` (502),
`tracker_store_unavailable` (503), `identity_unavailable` (503). Timestamps
RFC 3339 UTC. IDs are ULIDs unless noted. All routes require a bearer: the
signed-in user's token forwarded by the edge, or an Access Key assertion
([Access Keys](#access-keys-v0111)); `GET /openapi.json` does not.

## Shapes

```ts
type Person = { sub: string; name: string; avatarUrl?: string; email?: string; profileUrl?: string }
type Me = Person & { role: 'Admin' | 'Editor' | 'Viewer'; isAdmin: boolean }

type Workspace = { id: string; key: string; name: string; issueCount: number; createdAt: string; updatedAt: string }

type StatusCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
type Status = { id: string; name: string; category: StatusCategory; position: number; color: string }
type Label  = { id: string; name: string; color: string }  // color: one of 'gray','red','orange','yellow','green','teal','blue','indigo','purple','pink'

type IssueType = 'bug' | 'feature' | 'task'
type Priority  = 'urgent' | 'high' | 'medium' | 'low' | 'none'
type Surface   = 'dashboard' | 'platform-api' | 'apth' | 'builder-console' | 'console-app' | 'cluster' | 'other'
type Report = { environment: string; surface: Surface; version?: string; steps?: string; expected?: string; actual?: string } // each text ≤ 4096 chars

type IssueRef = { id: string; identifier: string; title: string; statusId: string }
type Issue = {
  id: string; identifier: string /* KEY-123 */; number: number
  title: string; description: string /* Markdown */
  type: IssueType; priority: Priority; statusId: string
  assignee: Person | null; reporter: Person
  labelIds: string[]
  parent: IssueRef | null; children: IssueRef[]; blocks: IssueRef[]; blockedBy: IssueRef[]
  dueOn: string | null /* YYYY-MM-DD */
  report: Report | null  // non-null iff type === 'bug'
  commentCount: number; attachmentCount: number
  createdAt: string; updatedAt: string; completedAt: string | null
}
type IssueSummary = Omit<Issue, 'description' | 'children' | 'blocks' | 'blockedBy'>  // list rows

type Comment    = { id: string; issueId: string; author: Person; body: string; createdAt: string; editedAt: string | null }
type Attachment = { id: string; issueId: string; filename: string; mediaType: string; size: number; url: string /* /api/tracker/v1/attachments/{id} */; uploader: Person; createdAt: string }
type Activity   = { id: string; issueId: string; actor: Person; field: 'created'|'title'|'description'|'type'|'priority'|'status'|'assignee'|'labels'|'parent'|'blocks'|'due'|'report'|'attachment'|'deleted'; from: unknown; to: unknown; createdAt: string }
type TimelineItem = { kind: 'activity'; activity: Activity } | { kind: 'comment'; comment: Comment }

type Filter = {
  status?: string[]; category?: StatusCategory[]
  assignee?: (string | 'me' | 'none')[]
  label?: string[]; type?: IssueType[]; priority?: Priority[]
  q?: string; createdAfter?: string; environment?: string[]; surface?: Surface[]
  parent?: string | 'none'
}
type Sort = 'updated' | 'created' | 'priority' | 'number'   // updated/created: desc; priority: urgent→none then updated desc; number: asc
type View = { id: string; name: string; owner: Person; shared: boolean; layout: 'list' | 'board'; filter: Filter; sort: Sort; position: number; createdAt: string; updatedAt: string }
```

Timeline `Activity.from`/`to` payloads by `field`: `status` → status id;
`labels` → label id[]; `assignee` → `Person | null`; `parent` → `IssueRef | null`;
`blocks` → `IssueRef[]`; `title`/`type`/`priority`/`due` → raw value;
`description`/`report` → old and new value; `attachment` → full `Attachment`
(`to` = added, `from` = removed); `created`/`deleted` → `null`.

There is no attachment list route: clients derive an issue's current
attachments from `attachment` activities (added minus removed).
Writes (`PATCH`/`DELETE /issues/{id}`, comments, attachments) take the ULID;
the `KEY-n` form is accepted on reads only. Shared views are edited only by
Admin. `PATCH /views/{id}` accepts `{ name?, layout?, filter?, sort?, shared?, position? }`.

## Routes

| Method & path | Body → Response | Authz |
| --- | --- | --- |
| `GET /me` | → `Me` | any |
| `GET /workspace` | → `Workspace` (created lazily: key `APT`, name = project id, default statuses seeded) | any |
| `PATCH /workspace` | `{ key?, name? }` → `Workspace` | Admin |
| `GET /statuses` | → `{ items: Status[] }` ordered by position | any |
| `POST /statuses` | `{ name, category, color? }` → `Status` (appended last in its category) | Admin |
| `PATCH /statuses/{id}` | `{ name?, color? }` → `Status` (category immutable) | Admin |
| `DELETE /statuses/{id}` | 204; 409 `conflict` if issues use it or last in category | Admin |
| `PUT /statuses/order` | `{ ids: string[] }` (all ids, new order; category grouping must be preserved) → `{ items: Status[] }` | Admin |
| `GET /labels` · `POST /labels` `{name,color}` · `PATCH /labels/{id}` · `DELETE /labels/{id}` | `Label` / `{ items }` / 204 | writes Admin |
| `GET /issues?filter=<url-encoded JSON Filter>&sort=<Sort>&cursor=&limit=` | → `{ items: IssueSummary[], nextCursor }`, limit default 50 max 200 | any |
| `POST /issues` | `{ title, description?, type, priority?, statusId?, assigneeSub?, labelIds?, parentId?, dueOn?, report? }` → `Issue` 201. `statusId` default: first `backlog` status. `report` required iff `type==='bug'` | any |
| `GET /issues/{idOrIdentifier}` | → `Issue` (`APT-12`, case-insensitive, or ULID) | any |
| `PATCH /issues/{id}` | any subset of `{ title, description, type, priority, statusId, assigneeSub (null clears), labelIds, parentId (null clears), blocks: string[] (replace set), dueOn, report }` → `Issue`; every changed field appends one `Activity`; `type` change bug↔other requires/clears `report`; cycles → 400 | any |
| `DELETE /issues/{id}` | 204 soft delete | Admin |
| `GET /issues/{id}/timeline` | → `{ items: TimelineItem[] }` ascending | any |
| `POST /issues/{id}/comments` | `{ body }` → `Comment` 201 | any |
| `PATCH /comments/{id}` | `{ body }` → `Comment` | author |
| `DELETE /comments/{id}` | 204 | author or Admin |
| `POST /issues/{id}/attachments` | multipart `file` → `Attachment` 201; ≤ 2 MiB, ≤ 10/issue, allowed media types only | any |
| `GET /attachments/{id}` | bytes, `Content-Type`, `Content-Disposition: inline; filename=…`, `Cache-Control: private, max-age=31536000, immutable` | any |
| `DELETE /attachments/{id}` | 204 | uploader or Admin |
| `GET /views` | → `{ items: View[] }` = shared ∪ mine, by position | any |
| `POST /views` | `{ name, layout?, filter?, sort?, shared? }` → `View` 201; `shared:true` Admin only | any |
| `PATCH /views/{id}` · `DELETE /views/{id}` | | owner; shared views Admin |
| `GET /people?q=` | → `{ items: Person[], source: 'directory' \| 'unavailable' }`; ≤ 20; Directory proxied with caller's bearer, 60 s cache; `[]`+`unavailable` when Directory absent | any |
| `GET /people/{id}/avatar?v=<avatarVersion>` | Directory image bytes (PNG, JPEG, WebP), ≤ 512 KiB; 404 when the person/avatar is absent; 502 for invalid or unavailable upstream content | any |
| `GET /openapi.json` | OpenAPI 3.1 document | none |

Default statuses seeded per workspace (name / category / color):
Backlog/backlog/gray, Todo/unstarted/gray, In Progress/started/yellow,
In Review/started/blue, Done/completed/green, Canceled/canceled/gray.

Moving to a `completed`/`canceled` status sets `completedAt`; leaving clears it.

Dev seed (`TRACKER_DEV_SEED=1`) and the SPA mock use the same fixture: ~30
issues across all statuses, 3 labels (`regression`, `ux`, `docs`), 2 shared
views (`Bugs`, `My issues`), 3 people.

### Directory avatars (v0.1.4)

`Person.avatarUrl`, when present, is a relative, same-origin
`/api/tracker/v1/people/{id}/avatar?v=<URL-encoded Directory avatarVersion>`.
The id is Directory's person id, not the OIDC subject. `profileUrl` remains
the Directory browser URL. No avatar URL is emitted without an avatar version.

The browser authenticates only to Tracker's edge. Tracker authenticates the
request, then uses its existing Directory link client to forward the caller's
`Authorization` header verbatim to the internal Directory binding. There is no
service credential and no client-supplied upstream URL. Direct browser images
from Directory are unreliable: that host has its own OIDC session, and its
avatar route requires a bearer. Cross-origin image embedding does not itself
require CORS, but it cannot supply Tracker's bearer or establish a Directory session.

Only Directory's `image/png`, `image/jpeg`, and `image/webp` content types
are accepted. The SDK transport refuses redirects and bounds reads to 4 MiB;
Tracker rejects empty or greater-than-512-KiB bodies before writing any image
bytes. Invalid content, oversized responses, and Directory outages return
502 `directory_avatar_unavailable`; missing Directory/person/avatar returns
404 `not_found`; upstream authorization denials remain 401/403.
The avatar route needs no Tracker database transaction.

Images have `X-Content-Type-Options: nosniff`, a version-and-content-keyed
`ETag`, and `Cache-Control: private, max-age=86400` when `v` is present
(`private, no-cache` otherwise). Matching `If-None-Match` returns 304 only
after authentication and a successful upstream fetch. The version is a cache
key, not a historical-image selector, so responses are not marked immutable.
Errors retain `no-store`. The SPA uses the shared avatar component everywhere
a person badge appears, with lazy images, name alt text, and initials on missing
URLs or image errors. The local mock gives Alex a PNG avatar; the other people
exercise the no-avatar fallback.

## Projects (v0.2)

A project groups issues inside the workspace (product area or workstream, e.g.
"Dashboard", "Builder Console"). It is a tracker concept, unrelated to the
AppThrust Project the app is installed in. An issue belongs to at most one
project; `null` means "no project".

```ts
type Project = {
  id: string; name: string /* 1–60, unique per workspace */; description: string /* ≤ 4096 bytes */
  color: string /* same palette as Label */; archived: boolean
  issueCount: number /* not deleted */; openIssueCount: number /* status category not completed/canceled */
  createdAt: string; updatedAt: string
}
```

Changes to existing shapes:

- `Issue` and `IssueSummary` gain `projectId: string | null`.
- `POST /issues` accepts `projectId?`; `PATCH /issues/{id}` accepts `projectId` (`null` clears).
  An unknown or archived project → 400 `invalid` (path `projectId`). Keeping an
  already-assigned archived project on an unrelated PATCH is allowed.
- `Filter` gains `project?: (string | 'none')[]`.
- `Activity.field` gains `'project'`; `from`/`to` are the project id or `null`.

| Method & path | Body → Response | Authz |
| --- | --- | --- |
| `GET /projects?includeArchived=true` | → `{ items: Project[] }` ordered by name; archived omitted unless requested | any |
| `POST /projects` | `{ name, description?, color? }` → `Project` 201; duplicate name → 409 | any |
| `GET /projects/{id}` | → `Project` | any |
| `PATCH /projects/{id}` | `{ name?, description?, color?, archived? }` → `Project` | any; `archived` Admin |
| `DELETE /projects/{id}` | 204; 409 `conflict` when any (non-deleted) issue references it — archive instead | Admin |

Fixture addition (dev seed and SPA mock): 3 projects `Dashboard` (blue),
`Platform API` (purple), `Builder Console` (orange); roughly two thirds of the
seeded issues are assigned across them, the rest have `projectId: null`.

## Reporter filter and "Reported by me" (v0.1.2)

- `Filter` gains `reporter?: (string | 'me')[]`: issue `reporter.sub` is one of
  the given subjects; `'me'` resolves to the caller, exactly like `assignee`.
  There is no `'none'` (every issue has a reporter). More than 20 entries or an
  empty string → 400 `invalid` (path `filter.reporter`), same limits as `assignee`.
- No new routes, no schema change (`tracker_issue.reporter_sub` already exists;
  add an index only if the list query needs one, as migration 009).
- "Reported by me" is a built-in view, not a stored `View` row: the SPA offers
  it to every user with filter `{ "reporter": ["me"] }` and sort `created`.
  It must exist on installations that have no saved views.
- Fixture: reporters already rotate across the 3 seeded people; make sure the
  dev-seed/mock "current user" (`Alex Chen` in the mock, the bearer subject on
  the server) reports at least 8 of the seeded issues so the view is not empty.

## Epics and stories (v0.1.7)

Work is bundled in a three-level hierarchy that reuses the existing
`parent` link; there is no new entity and no new write route.

| Level | `type` | Meaning | Allowed `parent` |
| --- | --- | --- | --- |
| 2 | `epic` | a theme or outcome that spans many stories | none (`parent` must be `null`) |
| 1 | `story` | one user story: who wants what, and why | `null` or an `epic` |
| 0 | `bug` · `feature` · `task` (work items) | a unit of work | `null`, an `epic`, a `story`, or another work item (sub-task) |

```ts
type IssueType = 'epic' | 'story' | 'bug' | 'feature' | 'task'
type Progress  = { total: number; completed: number }
```

Invariants (pure, `domain.ValidateHierarchy(childType, parentType)`; the SPA
mirrors them in `web/src/model/issues.ts`):

- `level(epic)=2`, `level(story)=1`, every other type `0`.
- A parent is valid when `level(child)=0`, or `level(parent) > level(child)`.
  So: epic→epic, story→story, story under a work item, and epic under
  anything are rejected with 400 `invalid` (path `parentId`).
- `PATCH` re-checks both directions when `type` or `parentId` changes: the
  issue against its (new) parent (path `parentId` when the parent changed,
  else `type`), and every direct child against the issue's new type
  (path `type`, e.g. turning an epic that has stories into a story).
- Cycle detection is unchanged. `report` stays "non-null iff `type==='bug'`".
- Nothing else distinguishes epics and stories: they have status, assignee,
  priority, labels, project, comments, and attachments like any issue, and
  their status is set by people, never derived.

Changes to existing shapes:

- `Issue` and `IssueSummary` gain
  - `epic: IssueRef | null` — the nearest **strict** ancestor of type `epic`;
  - `story: IssueRef | null` — the nearest strict ancestor of type `story`;
  - `progress: Progress | null` — non-null iff `type` is `epic` or `story`:
    over all descendants (any depth, not deleted) of level 0, `total` counts
    those whose status category is not `canceled`, `completed` those in
    `completed`.
  An epic has `epic: null`; a story has `story: null`. The ancestor walk is
  bounded to 32 hops.
  A soft-deleted issue is not part of the hierarchy: as `parent` already reads
  a deleted parent as `null`, the `epic`/`story` walk ends at a deleted node
  and `progress` counts nothing reachable only through one.
- `Filter` gains `epic?: (string | 'none')[]` and `story?: (string | 'none')[]`:
  the issue's `epic` (resp. `story`) as defined above is one of the ids;
  `'none'` matches issues without one. An id that is not a ULID → 400
  `invalid`. `Filter.type` accepts the two new types. `Filter.parent` is
  unchanged (direct parent).
- `View` gains `groupBy: 'none' | 'epic' | 'story'` (default `'none'`);
  `POST /views` and `PATCH /views/{id}` accept `groupBy?`. An unknown value →
  400 `invalid`.
- `POST /issues` and `PATCH /issues/{id}` accept the new types; no new fields.
- No new `Activity.field`: bundling an issue is a `parent` activity, changing
  its kind a `type` activity.

Grouping is a client-side presentation of the list response: with `groupBy`
`epic` (resp. `story`), rows are sectioned by `issue.epic?.id`
(`issue.story?.id`), sections ordered by the group's `number`, the "no
epic"/"no story" section last. Issues of the grouping type itself, and of a
higher level, are section headers, not rows (an epic never appears as a card
inside an epic lane).

Storage (migration `010_epics_stories.sql`): the `type` CHECK admits `epic`
and `story`; `tracker_view.group_by` is added. `epic`/`story`/`progress` are
derived at read time from `parent_id` with recursive queries
(`tracker_issue_parent` index); nothing is denormalized, so re-parenting a
subtree needs no fan-out write.

Fixture addition (dev seed and SPA mock, identical): 2 epics
(`Reliable bug intake`, `Faster triage`) and 4 stories (two per epic; titles
in the "As a …, I want …" form), all in status `In Progress`, created after
the existing issues so earlier numbers do not move. Existing seeded issues
`n` (1-based, in seed order) with `n % 5 != 0` get the parent
`stories[n % 4]`; the rest keep `parent: null`. One shared view
`By epic` (`layout: 'board'`, `groupBy: 'epic'`, empty filter) is added after
`Bugs` and `My issues`.

## Sprints, estimates, burndown and velocity (v0.1.10)

Work is cut into one- or two-week sprints; issues carry a T-shirt-size
estimate; a ledger of signed deltas yields burndown and velocity.

| Entity | Owner (sole writer) | Lifecycle | Invariants |
| --- | --- | --- | --- |
| **Estimate** (field on Issue) | any signed-in user | set, changed, cleared | T-shirt size `XS`, `S`, `M`, `L`, `XL`, or `null` (not estimated); not allowed on `epic`. Each size has a fixed Fibonacci point weight used only for sums: `XS=1`, `S=2`, `M=3`, `L=5`, `XL=8` (`domain.SizePoints`). People pick and read sizes; numbers appear only in sprint totals and charts. |
| **Sprint** | any signed-in user; delete Admin | `planned → active → closed`, explicit `start` and `close`; never reopened | `lengthWeeks ∈ {1, 2}`; `endsOn = startsOn + 7·lengthWeeks − 1`; date ranges of non-closed sprints do not overlap; at most one `active`; `number` from a per-workspace sequence; only a `planned` sprint is deleted or re-dated. |
| **Sprint membership** (`issue.sprintId`) | any signed-in user | set, moved, cleared; frozen once the sprint is closed | target sprint is `planned` or `active`; `epic` cannot be a member; **lineage-exclusive**: an issue cannot join a sprint that already contains one of its strict ancestors or descendants. |
| **Sprint event** (ledger) | server, in the transaction of the issue write that caused it | append-only; no rows after `closedAt` | one row per (write, sprint) with four signed deltas; the sum of a sprint's rows equals its current totals. |
| **Sprint settings** (on Workspace) | Admin | defaults | `sprintLengthWeeks ∈ {1, 2}` (default `1`), `timezone` IANA name (default `Asia/Tokyo`). |

Vocabulary: **scope** = member issues that are not deleted and not in a
`canceled` status; **done** = scope issues in a `completed` status;
**remaining** = scope − done; **commitment** = scope at `startedAt`;
**velocity** = done at `closedAt`. Every quantity exists in two units,
`points` (sum of the members' size weights, `null` counts 0) and `issues`
(count).


### The ledger rule (pure)

```go
// domain/sprint.go — no context, clock, or I/O.
type SprintStanding struct { SprintID string; Size string /* "" = not estimated */; Category string; Deleted bool }
type SprintTally    struct { ScopePoints, ScopeIssues, DonePoints, DoneIssues int }

func Contribution(s SprintStanding) SprintTally           // zero when SprintID=="" or Deleted or Category==canceled
func SprintDeltas(before, after SprintStanding) map[string]SprintTally // per sprint id; zero tallies omitted
func Burndown(baseline SprintTally, events []SprintEvent, days []Day) []BurndownPoint
func ValidateSprintDates(startsOn Date, lengthWeeks int, others []SprintSpan) error
func ValidateMembership(issueType string, sprintState string, lineageMembers int) error
```

`SprintDeltas` is `Contribution(after) − Contribution(before)`, attributed to
each standing's sprint. Moving between sprints, estimating, completing,
reopening, canceling and soft-deleting are all the same subtraction, so a new
field that affects scope extends `SprintStanding` and nothing else. The store
calls it in `CreateIssue`, `PatchIssue` and `DeleteIssue` after loading the
row and writes one `tracker_sprint_event` per returned sprint that is not
closed.


```ts
type SprintState = 'planned' | 'active' | 'closed'
type Tally  = { scopePoints: number; scopeIssues: number; donePoints: number; doneIssues: number }
type Sprint = {
  id: string; number: number; name: string /* 1–60, default "Sprint <number>" */; goal: string /* ≤ 4096 bytes */
  state: SprintState; lengthWeeks: 1 | 2
  startsOn: string; endsOn: string /* YYYY-MM-DD, workspace timezone, inclusive */
  startedAt: string | null; closedAt: string | null
  current: Tally               // sum of the ledger
  commitment: Tally | null     // ledger at startedAt; null while planned
  createdAt: string; updatedAt: string
}
type SprintRef = { id: string; number: number; name: string; state: SprintState }
type Unit = 'points' | 'issues'
type BurndownPoint = { day: string; scope: number; done: number; remaining: number; ideal: number }
type Burndown = { sprint: SprintRef; unit: Unit; today: string; points: BurndownPoint[] /* one per day startsOn..endsOn; days after today omit scope/done/remaining */ }
type VelocityEntry = { sprint: SprintRef; lengthWeeks: 1 | 2; committed: number; completed: number }
type Velocity = { unit: Unit; items: VelocityEntry[] /* closed sprints, oldest first */; averagePerWeek: number | null /* over the last 3 closed sprints */ }
```

Changes to existing shapes:

- `type Size = 'XS' | 'S' | 'M' | 'L' | 'XL'`. `Issue` and `IssueSummary` gain
  `estimate: Size | null` and
  `sprint: SprintRef | null`.
- `POST /issues` accepts `estimate?`, `sprintId?`; `PATCH /issues/{id}`
  accepts `estimate` and `sprintId` (`null` clears). Violations → 400
  `invalid` with path `estimate` or `sprintId` (unknown or closed sprint,
  epic, lineage member already in the sprint). A `PATCH` that changes `type`
  or `parentId` re-checks membership, as the hierarchy check does.
- `Filter` gains `sprint?: (string | 'active' | 'none')[]`.
- `Sort` gains `'estimate'` (`XL` → `XS`, `null` last, then `updated` desc).
- `View.groupBy` gains `'sprint'`.
- `Activity.field` gains `'estimate'` (raw value) and `'sprint'`
  (`SprintRef | null`).
- `Workspace` gains `sprintLengthWeeks: 1 | 2` and `timezone: string`;
  `PATCH /workspace` accepts both (Admin).
- `Progress` (epic/story) gains `points: { total: number; completed: number }`
  (sum of size weights).

| Method & path | Body → Response | Authz |
| --- | --- | --- |
| `GET /sprints?state=` | → `{ items: Sprint[] }` active, then planned by `startsOn`, then closed newest first | any |
| `POST /sprints` | `{ name?, goal?, startsOn?, lengthWeeks? }` → `Sprint` 201. Defaults: `lengthWeeks` = workspace setting; `startsOn` = day after the latest non-closed sprint's `endsOn`, else the coming Monday. Overlap → 409 | any |
| `GET /sprints/{id}` | → `Sprint` | any |
| `PATCH /sprints/{id}` | `{ name?, goal?, startsOn?, lengthWeeks? }` → `Sprint`; dates only while `planned` (409 otherwise) | any |
| `POST /sprints/{id}/start` | → `Sprint`; 409 when another sprint is active or this one is not `planned`. Sets `startedAt`; `startsOn` becomes today when it was in the future, keeping `lengthWeeks` | any |
| `POST /sprints/{id}/close` | `{ moveIncompleteTo: string \| null }` → `Sprint`; target is a `planned` sprint id or `null` (backlog). Sets `closedAt`, then moves scope issues that are not done; the move is recorded only on the target's ledger | any |
| `DELETE /sprints/{id}` | 204; only `planned`; members return to the backlog | Admin |
| `GET /sprints/{id}/burndown?unit=&project=` | → `Burndown` | any |
| `GET /velocity?unit=&project=&limit=` | → `Velocity`; `limit` default 8, max 26 | any |

Chart semantics:

- Day boundaries are midnights in `Workspace.timezone`. A point is the ledger
  summed up to the end of that day (up to now for `today`, up to `closedAt`
  for the last day of a closed sprint).
- `ideal` descends linearly from the commitment's remaining at `startsOn` to 0
  at `endsOn`, flat across Saturdays and Sundays.
- `project` (an id or `none`) restricts the sum to events of issues currently
  in that project.
- `Velocity.completed` is done at `closedAt`; `committed` is scope at
  `startedAt`. `averagePerWeek` divides by `lengthWeeks`, so one- and two-week
  sprints are comparable; the SPA shows `averagePerWeek × lengthWeeks` as the
  suggested commitment while planning.

Storage (migration `011_sprints.sql`):

```sql
ALTER TABLE tracker_workspace ADD sprint_length_weeks int NOT NULL DEFAULT 1 CHECK (sprint_length_weeks IN (1,2)),
                              ADD timezone text NOT NULL DEFAULT 'Asia/Tokyo';
CREATE TABLE tracker_sprint (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES tracker_workspace(id),
  number bigint NOT NULL, name text NOT NULL, goal text NOT NULL DEFAULT '',
  length_weeks int NOT NULL CHECK (length_weeks IN (1,2)), starts_on date NOT NULL, ends_on date NOT NULL,
  started_at timestamptz, closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, number),
  CHECK (ends_on = starts_on + 7 * length_weeks - 1),
  CHECK (closed_at IS NULL OR started_at IS NOT NULL)
);
CREATE UNIQUE INDEX tracker_sprint_one_active ON tracker_sprint (workspace_id) WHERE started_at IS NOT NULL AND closed_at IS NULL;
ALTER TABLE tracker_issue ADD estimate text CHECK (estimate IN ('XS','S','M','L','XL')),
                          ADD sprint_id text REFERENCES tracker_sprint(id),
                          ADD CHECK (type <> 'epic' OR (estimate IS NULL AND sprint_id IS NULL));
CREATE INDEX tracker_issue_sprint ON tracker_issue (sprint_id) WHERE sprint_id IS NOT NULL;
CREATE TABLE tracker_sprint_event (
  id text PRIMARY KEY, sprint_id text NOT NULL REFERENCES tracker_sprint(id) ON DELETE CASCADE,
  issue_id text NOT NULL REFERENCES tracker_issue(id) ON DELETE CASCADE, at timestamptz NOT NULL DEFAULT now(),
  scope_points int NOT NULL, scope_issues int NOT NULL, done_points int NOT NULL, done_issues int NOT NULL
);
CREATE INDEX tracker_sprint_event_sprint ON tracker_sprint_event (sprint_id, at);
```

`state` is derived from `started_at`/`closed_at`, not stored. The overlap
invariant is checked in the transaction that takes the existing workspace row
lock; the partial unique index backs "one active".

Fixture (dev seed and SPA mock, identical): three closed one-week sprints
with ledgers that yield velocities 18, 21, 24 points, one active two-week
sprint on its fourth day with a scope increase and one cancellation, one
planned sprint; about half of the seeded work items carry a size, spread
over all five.

## Access Keys (v0.1.11)

Scripts, CLIs and coding agents call this API without a browser session. The
mechanism is the platform's Access Keys
(`appthrust/platform` `design/platform/access-keys/README.md`); Tracker adds no
credential of its own.

`catalog/entry.yaml` declares the space: audience `tracker`, key prefix `trk`,
scopes `tracker:read` and `tracker:write`, and `bearerPassThrough` so the edge
verifies a bearer instead of starting a sign-in. The platform projects
`TRACKER_ACCESS_AUDIENCE` and `PLATFORM_ACCESS_ISSUER`.

```sh
apth access-keys create --project <project> --space tracker --scope tracker:read --scope tracker:write
printf %s "$KEY" | apth access-keys exchange --project <project>   # assertion, valid ≤ 5 min
curl -H "Authorization: Bearer <assertion>" https://tracker.<project-host>/api/tracker/v1/issues
```

Rules (`cmd/server/internal/api/keys.go`, `keyActor`):

| Rule | Result when violated |
| --- | --- |
| The raw key is exchanged first; only the assertion is a bearer | 401 `raw_key_not_accepted` |
| The assertion's Project equals `PLATFORM_PROJECT_ID`. The audience is the same in every Project, so this claim is the tenant boundary | 401 `unauthenticated` |
| The key's subject is a user. Every write records a person; component, external and cluster keys have none | 403 `key_subject` |
| `GET` routes need `tracker:read`; every other method needs `tracker:write`. Neither implies the other | 403 `insufficient_scope` |
| The key acts as its user (`sub` = the subject id) with role `Viewer`. The Platform role is not looked up, so Admin-only routes stay with signed-in users | 403 `forbidden` |
| `GET /people/{id}/avatar` is Directory's data under Directory's authority | 403 `key_subject` |

What the user's key creates belongs to that user: `reporter: ['me']` in the
SPA lists it. The assertion carries no name or email and is never forwarded to
Directory. Since v0.1.12 the key's person takes the display name of that
user's most recent signed-in write in this workspace (`store.KnownName`, from
the activity log); before any such write the name is the subject id. `GET /me`
returns `{ sub, name, role: 'Viewer', isAdmin: false }` with the same name.
`GET /people` answers `source: 'unavailable'`; a signed-in reader still sees
the Directory name.

Each mutation request made with a key writes one `tracker access key mutation:`
log line (method, path, key name, subject, edge `X-Request-Id`) before
authorization. The timeline does not distinguish key writes from the user's own.

## Agents: people and AI agents on the same board

An Access Key whose subject is `external` is a registered agent, not a person.
Agents are assignable actors; a run is a lease that shows an agent is working;
a request is a directed, stateful handoff; under the `review` policy only a
person's approval completes an agent's work. User keys ("Access Keys
(v0.1.11)") are unchanged.

An **Actor** is a person or an agent. Everything a person can be on an issue
(assignee, reporter, comment author, activity actor) an agent can be too.

| Entity | Owner (sole writer) | Lifecycle | Invariants |
| --- | --- | --- | --- |
| **Agent** | Admin | `active ⇄ disabled`; never deleted (history refers to it) | has an immutable `id` and an immutable, unique `handle` (see "Identifiers"); `name` and `description` are editable; exactly one `owner` Person, who is accountable for what it does; an Assertion whose `external` subject equals no active agent's handle is refused (403 `key_subject`). |
| **Delegation** (fields on Issue) | whoever assigns | set when the assignee becomes an agent, cleared when it becomes a person or nobody | `delegator` is a Person: the person who assigned, or the agent's owner when an agent assigned (itself or another agent). The delegator is who the agent answers to on this issue. |
| **Run** | the agent that started it; a person may cancel | `running ⇄ waiting → succeeded \| failed \| canceled` | only the issue's assignee starts a run; at most one non-terminal run per issue; holds a lease (`leaseExpiresAt`, 10 minutes, renewed by heartbeat, compared at microsecond precision); a run whose lease has passed is `stalled` (derived at read time). A stalled run blocks nothing and is never revived: heartbeat and finish are refused, and the next start on the issue closes it as `failed/lease_expired`. Changing the assignee away from the agent cancels its non-terminal run (`reassigned`) in the same transaction. Whatever ends a run without success (cancel, reassignment, expiry closure) withdraws its open requests. |
| **Request** | requester creates and withdraws; addressee answers | `open → answered \| withdrawn` | `kind ∈ {question, approval, review}`; directed from one actor to one actor, or to "any person"; `approval` and `review` are answered only by people; a `review` exists only as the result of a finished run; only a run's own agent attaches a request to that run, and the run must belong to the same issue (otherwise anyone could force a run into `waiting`). |
| **Mention** | server, parsed from a comment | created with the comment; acknowledged by its target | `@handle` of an agent; one row per (comment, target). People are not mentionable in this version (Directory has no lookup by typed text). |
| **Event** | server, in the transaction of the write it describes | append-only | `seq` allocated from the workspace row, so order of `seq` is commit order and a reader never misses a row behind its cursor. |
| **Completion policy** (on Workspace) | Admin | setting | `agentCompletion ∈ {review, direct}`, default `review`. |

### Identifiers

| Identifier | Example | Mutable | Used for |
| --- | --- | --- | --- |
| `id` (ULID, server-assigned) | `01M74SFSZ657XZ2HNWWA9VND8T` | no | the reference history keeps: assignee, reporter, author and actor columns store `agent:<id>` |
| `handle` (`^[a-z][a-z0-9-]{1,30}$`, unique) | `astra` | no | what people type and read (`@astra`, assignee picker) **and** the `external` subject of the agent's Access Keys: `apth access-keys create --space tracker --external astra` |
| `name` | `Astra` | yes | display |

There is no separate key subject: one name per agent for the Admin to manage.
Keys come and go (expiry, revocation, several at once); every key minted with
the handle as its `external` subject is the same agent. The price is that a
handle cannot be renamed; the display name can. A session or lane has no
identifier of its own: it is the free-text `session` of a Run.

### Authorization

`domain.Actor` gains `Kind`. `Can` stays pure and gains these rows:

| Action | Person | Agent (scope) |
| --- | --- | --- |
| Read issues, timeline, sprints, feed | any | `tracker:read` |
| Create issues, comment, attach, raise `question`/`approval` Requests, answer a `question` addressed to it — on any issue | any | `tracker:write` |
| Edit an issue's fields (`PATCH /issues/{id}`) | any | `tracker:write`, and only as the issue's assignee or reporter |
| Start and drive a run | n/a | `tracker:write`, assignee only |
| Set a `completed` status | any | only when `agentCompletion = direct` |
| Answer `approval` / `review` | addressee, or any person when unaddressed; Admin | never |
| Cancel a run | any | its own |
| Assign to an agent | any | itself, on issues it reported |
| Delete, settings, statuses, labels, shared views, sprint start/close/delete, manage agents | as today | never |
| `GET /people` (Directory) | any | empty, `source: unavailable` (Directory accepts only user bearers) |


Authentication: every route accepts the edge user bearer or an Access Key
Assertion (audience `tracker`). A key without the needed scope → 403
`insufficient_scope` (as for user keys); a refusal by the authorization table
→ 403 `forbidden`.

```ts
type ActorKind = 'person' | 'agent'
type Actor = Person & { kind: ActorKind; agent?: { id: string; handle: string; owner: Person; disabled: boolean } }
// For agents: sub = 'agent:<id>', name = agent name. Every place that returned Person returns Actor.

type Agent = { id: string; handle: string /* immutable; also the external subject of its Access Keys */
  name: string; description: string /* ≤ 4096 bytes: what to delegate to it */
  owner: Person; disabled: boolean
  activeRuns: number; openRequests: number; lastSeenAt: string | null; createdAt: string; updatedAt: string }

type RunState = 'running' | 'waiting' | 'stalled' | 'succeeded' | 'failed' | 'canceled'
type Link = { kind: 'pr' | 'commit' | 'url'; url: string /* https */; title: string /* ≤ 200 */ }
type Run = { id: string; issue: IssueRef; agent: Actor; state: RunState; reason: string | null /* 'lease_expired' | 'reassigned' | 'canceled_by:<sub>' */
  session: string /* ≤ 200, free text */; note: string /* ≤ 200, latest heartbeat */
  summary: string /* Markdown ≤ 20 KiB, set on finish */; links: Link[] /* ≤ 10 */
  startedAt: string; heartbeatAt: string; leaseExpiresAt: string; finishedAt: string | null }

type RequestKind = 'question' | 'approval' | 'review'
type Request = { id: string; issue: IssueRef; kind: RequestKind; from: Actor; to: Actor | null /* null = any person */
  title: string /* 1–200 */; body: string /* Markdown ≤ 20 KiB */; options: string[] /* ≤ 6; approval/review: fixed ['approve','reject'] */
  runId: string | null; state: 'open' | 'answered' | 'withdrawn'
  answer: { option: string | null; body: string; by: Actor; at: string } | null; createdAt: string }

type InboxItem =
  | { kind: 'request'; request: Request }                       // open, addressed to me (or to any person, when I am one)
  | { kind: 'answer'; request: Request }                        // my request was answered; until acknowledged
  | { kind: 'mention'; comment: Comment; issue: IssueRef }      // until acknowledged
  | { kind: 'assignment'; issue: IssueSummary }                 // agents only: assigned to me and actionable; carries activeRun when I already hold a live run (resume, do not start again)
type Event = { seq: number; at: string; issue: IssueRef | null; actor: Actor
  type: 'issue.created' | 'issue.updated' | 'issue.deleted' | 'comment.created' | 'run.started' | 'run.finished' | 'run.canceled' | 'request.opened' | 'request.answered' | 'request.withdrawn'
  data: unknown /* issue.updated: { fields: Activity['field'][] }; others: the entity id */ }
```

"Actionable" (pure, `domain.Actionable`): not deleted; status category
`backlog`, `unstarted` or `started` (assignment is the delegation, so an
issue assigned while still in Backlog reaches the agent); no live (not
stalled) run of another agent; no open Request raised by me on it, ignoring
requests attached to a stalled run; no `blockedBy` issue outside
`completed`/`canceled`. Ordered by priority, then sprint membership (active
sprint first), then number.

Changes to existing shapes:

- `Issue`/`IssueSummary`: `assignee`, `reporter` are `Actor`; gain
  `delegator: Person | null`, `activeRun: Run | null`, `openRequestCount: number`.
- `POST`/`PATCH /issues`: `assigneeSub` accepts `agent:<id>`; a disabled agent
  → 400 (path `assigneeSub`). `PATCH` accepts `expectedUpdatedAt?`; a mismatch
  → 409 `conflict`. An agent setting a `completed` status under `review` → 403.
- All `POST` routes except the multipart attachment upload honour
  `Idempotency-Key` (≤ 128 chars): the first handler status and body are kept
  24 h per (actor, key) and replayed for the identical request (method, URI,
  content type, body bytes); a different request under the same key → 409.
  Authentication failures are not stored.
- `Filter` gains `assigneeKind?: ActorKind[]`, `agent?: string[]` (the
  assignee is one of these agent ids),
  `run?: ('active' | 'stalled' | 'none')[]`, `request?: ('open' | 'mine')[]`
  (`open`: the issue has an open request; `mine`: an open request raised by
  the caller).
- `TimelineItem` gains `{ kind: 'run'; run: Run }` and `{ kind: 'request'; request: Request }`.
- `Activity.field` gains `'delegator'`. `Me` gains `kind` and, for agents, `agent` and `scopes`.
- `Workspace` gains `agentCompletion: 'review' | 'direct'`; `PATCH /workspace` accepts it (Admin).
- `Comment` gains `mentions: Actor[]`.

| Method & path | Body → Response | Authz |
| --- | --- | --- |
| `GET /agents?includeDisabled=` | → `{ items: Agent[] }` | any |
| `POST /agents` | `{ handle, name, description?, ownerSub }` → `Agent` 201; duplicate handle → 409 | Admin |
| `PATCH /agents/{id}` | `{ name?, description?, ownerSub?, disabled? }` → `Agent`; disabling cancels its non-terminal runs | Admin |
| `GET /inbox` | → `{ items: InboxItem[] }` for the caller, requests first | any |
| `POST /inbox/ack` | `{ answers?: string[] /* request ids */; mentions?: string[] /* comment ids */ }` → 204 | any |
| `GET /events?after=<seq>&limit=` | → `{ items: Event[]; next: number }`, ascending, limit default 100 max 500; `after` omitted = from now | any |
| `POST /issues/{id}/runs` | `{ session?, note? }` → `Run` 201; caller must be the assignee (403); another live run → 409; a stalled run is first closed `failed/lease_expired` and its open requests withdrawn | agent |
| `GET /issues/{id}/runs` · `GET /runs/{id}` | → `{ items: Run[] }` newest first / `Run` | any |
| `POST /runs/{id}/heartbeat` | `{ note? }` → `Run`; renews the lease; 409 when the run is terminal or stalled (the agent must stop and start a fresh run) | the run's agent |
| `POST /runs/{id}/finish` | `{ outcome: 'succeeded' \| 'failed', summary, links? }` → `Run`; 409 when terminal or stalled; `succeeded` with an open `approval` of this run → 409 (resolve or withdraw it first); `succeeded` under `review` opens a `review` Request to the delegator and withdraws the run's open questions | the run's agent |
| `POST /runs/{id}/cancel` | → `Run`; accepts a stalled run; withdraws the run's open requests | any person; the run's agent |
| `POST /issues/{id}/requests` | `{ kind: 'question' \| 'approval', title, body?, options?, to?: string \| null /* sub */, runId? }` → `Request` 201; for agents `to` omitted = the delegator (else the owner), `to: null` = any person; `runId` only by that run's agent and for a run of this issue (403), and sets the run `waiting` | any |
| `GET /requests?state=&to=&issue=` · `GET /requests/{id}` | | any |
| `POST /requests/{id}/answer` | `{ option?, body? }` → `Request`; `option` must be one of `options` when they exist; approving a `review` moves the issue to the first `completed` status in the same transaction, rejecting leaves it and is an inbox `answer` for the agent; the last open request answered returns the run to `running` | per the authorization table |
| `POST /requests/{id}/withdraw` | → `Request` | requester |
| `GET /agent-guide` | → `text/markdown`: this protocol written for an agent (exchange, inbox loop, run, request, finish), generated from the route table | any |

Catalog entry: unchanged. Agents use the existing `tracker` space and its
scopes (`tracker:read` for `GET`, `tracker:write` otherwise, as for user keys).

Storage (migration `013_agents.sql`): `tracker_agent`; `tracker_run`
(partial unique index on `issue_id` where not terminal); `tracker_request`;
`tracker_mention`; `tracker_event (workspace_id, seq)` with
`tracker_workspace.event_seq`; `tracker_idempotency (actor_sub, key)`;
`tracker_issue.delegator_sub/name`; `tracker_workspace.agent_completion`.
Agent actors are stored in the existing `*_sub` columns as `agent:<id>`, so no
existing column changes type. Expired idempotency rows are deleted
opportunistically by the write that inserts a new one.

### UI

- **Actor rendering**: an agent shows its own glyph and a tooltip "owned by
  <person>" wherever a person badge appears. The assignee picker lists agents
  in their own section with the agent's description.
- **Board and list**: a card with a live run shows the agent and its latest
  note ("astra · running tests · 3 分前"); `stalled` and "waiting for a person"
  are visually distinct. Built-in views "Agents at work" (`run: ['active']`)
  and "Waiting for people" (`request: ['open']`).
- **Inbox** (`/inbox`, sidebar count, `G I`): the person's queue. Open
  requests first, each answerable in place (option buttons, or text); then
  answers and mentions. A `review` shows the run summary and links beside
  Approve / Reject.
- **Issue panel**: runs and requests appear in the timeline; an open request
  is pinned above the description. "Delegate to agent" is the assign action;
  "Cancel run" is on the live run.
- **Agents** (`/settings/agents`, Admin): register (handle, name, owner,
  description), disable; shows the exact
  `apth access-keys create --space tracker --external <handle>` command and
  last seen, active runs, open requests and the median time a request waited
  for a person. (Runs by outcome needs a cross-issue run listing and a
  Dashboard link needs the Dashboard URL; neither exists, so neither is shown.)
- **Settings**: completion policy.
- Copy in Japanese and English (`web/src/copy/agents.ts`).
