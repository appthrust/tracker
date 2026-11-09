# Tracker API contract (`/api/tracker/v1`)

Authoritative for both the Go server (`cmd/server/internal/api`, which also
emits `openapi.json` from these shapes) and the SPA mock
(`web/src/dev/mock-tracker.ts`). Change this file first.

Conventions (SDK `httpx`): success bodies are the resource or
`{ "items": [...], "nextCursor": string|null }`; errors are
`{ "error": "<code>", "message": "...", "issues"?: [{path, message}] }` with
codes `invalid` (400), `unauthenticated` (401), `forbidden` (403),
`not_found` (404), `conflict` (409), `tracker_store_unavailable` (503),
`identity_unavailable` (503). Timestamps RFC 3339 UTC. IDs are ULIDs unless
noted. All routes require the edge bearer; `GET /openapi.json` does not.

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
| `GET /openapi.json` | OpenAPI 3.1 document | none |

Default statuses seeded per workspace (name / category / color):
Backlog/backlog/gray, Todo/unstarted/gray, In Progress/started/yellow,
In Review/started/blue, Done/completed/green, Canceled/canceled/gray.

Moving to a `completed`/`canceled` status sets `completedAt`; leaving clears it.

Dev seed (`TRACKER_DEV_SEED=1`) and the SPA mock use the same fixture: ~30
issues across all statuses, 3 labels (`regression`, `ux`, `docs`), 2 shared
views (`Bugs`, `My issues`), 3 people.
