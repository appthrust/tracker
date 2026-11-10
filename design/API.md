# Tracker API contract (`/api/tracker/v1`)

Authoritative for both the Go server (`cmd/server/internal/api`, which also
emits `openapi.json` from these shapes) and the SPA mock
(`web/src/dev/mock-tracker.ts`). Change this file first.

Conventions (SDK `httpx`): success bodies are the resource or
`{ "items": [...], "nextCursor": string|null }`; errors are
`{ "error": "<code>", "message": "...", "issues"?: [{path, message}] }` with
codes `invalid` (400), `unauthenticated` (401), `forbidden` (403),
`not_found` (404), `conflict` (409), `directory_avatar_unavailable` (502),
`tracker_store_unavailable` (503), `identity_unavailable` (503). Timestamps
RFC 3339 UTC. IDs are ULIDs unless noted. All routes require the edge bearer;
`GET /openapi.json` does not.

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

## Epics and stories (v0.1.6)

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
