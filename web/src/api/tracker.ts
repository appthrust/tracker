// Tracker API (`/api/tracker/v1/*`, served by cmd/server from the SPA's own
// origin; contract: design/API.md). The OIDC edge (Envoy) in front of the
// server attaches the caller's bearer token; the SPA never sees or requests
// one. Lists are `{items}` (issues add `nextCursor`), single resources are
// direct objects, errors are `{error, message, issues?}`.

export type Person = { sub: string; name: string; avatarUrl?: string; email?: string; profileUrl?: string }
export type Role = 'Admin' | 'Editor' | 'Viewer'
export type Me = Person & { role: Role; isAdmin: boolean }

export type Workspace = { id: string; key: string; name: string; issueCount: number; createdAt: string; updatedAt: string }

export type StatusCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
export type Status = { id: string; name: string; category: StatusCategory; position: number; color: string }
export type LabelColor = 'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'indigo' | 'purple' | 'pink'
export type Label = { id: string; name: string; color: LabelColor }
/** A workspace-internal grouping of issues (product area, workstream); unrelated to the AppThrust Project the app runs in. */
export type Project = {
  id: string
  /** 1–60 characters, unique per workspace. */
  name: string
  /** ≤ 4096 bytes. */
  description: string
  color: LabelColor
  archived: boolean
  /** Non-deleted issues in the project. */
  issueCount: number
  /** Issues whose status category is neither completed nor canceled. */
  openIssueCount: number
  createdAt: string
  updatedAt: string
}

export type IssueType = 'bug' | 'feature' | 'task'
export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none'
export type Surface = 'dashboard' | 'platform-api' | 'apth' | 'builder-console' | 'console-app' | 'cluster' | 'other'
/** Each text ≤ 4096 characters. */
export type Report = { environment: string; surface: Surface; version?: string; steps?: string; expected?: string; actual?: string }

export type IssueRef = { id: string; identifier: string; title: string; statusId: string }
export type Issue = {
  id: string
  /** `KEY-123` */
  identifier: string
  number: number
  title: string
  /** Markdown as written; the SPA renders and sanitizes it. */
  description: string
  type: IssueType
  priority: Priority
  statusId: string
  assignee: Person | null
  reporter: Person
  labelIds: string[]
  /** The tracker project, or null for "no project". */
  projectId: string | null
  parent: IssueRef | null
  children: IssueRef[]
  blocks: IssueRef[]
  blockedBy: IssueRef[]
  /** YYYY-MM-DD */
  dueOn: string | null
  /** Non-null iff `type === 'bug'`. */
  report: Report | null
  commentCount: number
  attachmentCount: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}
export type IssueSummary = Omit<Issue, 'description' | 'children' | 'blocks' | 'blockedBy'>

export type Comment = { id: string; issueId: string; author: Person; body: string; createdAt: string; editedAt: string | null }
export type Attachment = { id: string; issueId: string; filename: string; mediaType: string; size: number; url: string; uploader: Person; createdAt: string }
export type ActivityField =
  | 'created'
  | 'title'
  | 'description'
  | 'type'
  | 'priority'
  | 'status'
  | 'assignee'
  | 'labels'
  | 'parent'
  | 'blocks'
  | 'due'
  | 'report'
  | 'attachment'
  | 'deleted'
  | 'project'
export type Activity = { id: string; issueId: string; actor: Person; field: ActivityField; from: unknown; to: unknown; createdAt: string }
export type TimelineItem = { kind: 'activity'; activity: Activity } | { kind: 'comment'; comment: Comment }

export type Filter = {
  status?: string[]
  category?: StatusCategory[]
  /** A subject, `me` or `none`. */
  assignee?: string[]
  /** Reporter subjects or `me` (no `none`: every issue has a reporter); at most 20. */
  reporter?: string[]
  label?: string[]
  type?: IssueType[]
  priority?: Priority[]
  q?: string
  createdAfter?: string
  environment?: string[]
  surface?: Surface[]
  /** An issue id or `none`. */
  parent?: string
  /** Project ids, or `none` for issues without a project. */
  project?: string[]
}
/** updated/created: desc; priority: urgent→none then updated desc; number: asc. */
export type Sort = 'updated' | 'created' | 'priority' | 'number'
export type ViewLayout = 'list' | 'board'
export type View = { id: string; name: string; owner: Person; shared: boolean; layout: ViewLayout; filter: Filter; sort: Sort; position: number; createdAt: string; updatedAt: string }

export type IssuePage = { items: IssueSummary[]; nextCursor: string | null }
export type PeopleResult = { items: Person[]; source: 'directory' | 'unavailable' }
export type ApiError = { error: string; message: string; issues?: { path: string; message: string }[] }

export type CreateIssueInput = {
  title: string
  description?: string
  type: IssueType
  priority?: Priority
  statusId?: string
  assigneeSub?: string
  labelIds?: string[]
  parentId?: string
  dueOn?: string
  report?: Report
  projectId?: string
}
export type UpdateIssueInput = Partial<{
  title: string
  description: string
  type: IssueType
  priority: Priority
  statusId: string
  assigneeSub: string | null
  labelIds: string[]
  parentId: string | null
  blocks: string[]
  dueOn: string | null
  report: Report | null
  /** null clears the project. */
  projectId: string | null
}>
export type CreateViewInput = { name: string; layout?: ViewLayout; filter?: Filter; sort?: Sort; shared?: boolean }
export type UpdateViewInput = Partial<CreateViewInput>
export type IssueListParams = { filter?: Filter; sort?: Sort; cursor?: string | null; limit?: number }
export type CreateProjectInput = { name: string; description?: string; color?: LabelColor }
/** `archived` is Admin only. */
export type UpdateProjectInput = Partial<{ name: string; description: string; color: LabelColor; archived: boolean }>

/**
 * Non-2xx tracker response. `code` is the server's stable snake_case error.
 * `transient` = no error envelope came back: a 5xx from a proxy in front of the
 * server (e.g. during a rollout), or no response at all (status 0).
 */
export class TrackerApiError extends Error {
  readonly status: number
  readonly code: string
  readonly transient: boolean
  readonly issues: { path: string; message: string }[]

  constructor(status: number, body: Partial<ApiError> | undefined) {
    const code = typeof body?.error === 'string' ? body.error : undefined
    super(body?.message || `tracker api ${status}`)
    this.name = 'TrackerApiError'
    this.status = status
    this.code = code ?? (status === 404 ? 'not_found' : 'unknown')
    this.transient = code === undefined && (status === 0 || status >= 500)
    this.issues = Array.isArray(body?.issues) ? body.issues : []
  }
}

export function isTrackerError(error: unknown, code?: string): error is TrackerApiError {
  return error instanceof TrackerApiError && (code === undefined || error.code === code)
}

export const BASE = '/api/tracker/v1'
const READ_TIMEOUT_MS = 8_000
// A 401 first sends the browser to `/` so the edge re-runs sign-in. Another 401
// within this window means the edge forwards a token the server rejects;
// redirecting again would loop, so that 401 reaches the screens instead.
const REAUTH_WINDOW_MS = 60_000
const REAUTH_AT_KEY = 'tracker:reauth-at'

type Fetcher = (input: string, init: RequestInit) => Promise<Response>

export interface TrackerApi {
  me(): Promise<Me>
  workspace: {
    get(): Promise<Workspace>
    update(input: { key?: string; name?: string }): Promise<Workspace>
  }
  statuses: {
    list(): Promise<Status[]>
    create(input: { name: string; category: StatusCategory; color?: string }): Promise<Status>
    update(id: string, input: { name?: string; color?: string }): Promise<Status>
    remove(id: string): Promise<void>
    reorder(ids: string[]): Promise<Status[]>
  }
  labels: {
    list(): Promise<Label[]>
    create(input: { name: string; color: LabelColor }): Promise<Label>
    update(id: string, input: { name?: string; color?: LabelColor }): Promise<Label>
    remove(id: string): Promise<void>
  }
  projects: {
    /** Ordered by name; archived ones only with `includeArchived`. */
    list(options?: { includeArchived?: boolean }): Promise<Project[]>
    get(id: string): Promise<Project>
    create(input: CreateProjectInput): Promise<Project>
    update(id: string, input: UpdateProjectInput): Promise<Project>
    /** 409 `conflict` while any issue references the project. */
    remove(id: string): Promise<void>
  }
  issues: {
    list(params?: IssueListParams): Promise<IssuePage>
    /** `APT-12` (case-insensitive) or ULID. */
    get(idOrIdentifier: string): Promise<Issue>
    create(input: CreateIssueInput): Promise<Issue>
    update(id: string, input: UpdateIssueInput): Promise<Issue>
    remove(id: string): Promise<void>
    timeline(id: string): Promise<TimelineItem[]>
    comment(id: string, body: string): Promise<Comment>
    attach(id: string, file: File): Promise<Attachment>
  }
  comments: {
    update(id: string, body: string): Promise<Comment>
    remove(id: string): Promise<void>
  }
  attachments: {
    remove(id: string): Promise<void>
  }
  views: {
    list(): Promise<View[]>
    create(input: CreateViewInput): Promise<View>
    update(id: string, input: UpdateViewInput): Promise<View>
    remove(id: string): Promise<void>
  }
  people(q?: string): Promise<PeopleResult>
}

/** `?filter=<JSON>&sort=&cursor=&limit=` with only the set parameters; an empty filter is omitted. */
export function issueSearch({ filter, sort, cursor, limit }: IssueListParams = {}): string {
  const search = new URLSearchParams()
  if (filter && Object.keys(filter).length > 0) search.set('filter', JSON.stringify(filter))
  if (sort) search.set('sort', sort)
  if (cursor) search.set('cursor', cursor)
  if (limit !== undefined) search.set('limit', String(limit))
  const text = search.toString()
  return text ? `?${text}` : ''
}

export function createTrackerApi(fetcher: Fetcher = (input, init) => fetch(input, init), reauth = browserReauth): TrackerApi {
  async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const read = method === 'GET'
    const multipart = body instanceof FormData
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined && !multipart) headers['Content-Type'] = 'application/json'
    let response: Response
    try {
      response = await fetcher(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
        credentials: 'same-origin',
        signal: read ? AbortSignal.timeout(READ_TIMEOUT_MS) : undefined,
      })
    } catch {
      // Network failure or read timeout: nothing answered.
      throw new TrackerApiError(0, undefined)
    }
    if (response.status === 401 && reauth()) return new Promise<T>(() => {})
    if (!response.ok) {
      let parsed: Partial<ApiError> | undefined
      try {
        parsed = (await response.json()) as Partial<ApiError>
      } catch {
        parsed = undefined
      }
      throw new TrackerApiError(response.status, parsed)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
  const list = async <T>(path: string) => (await send<{ items: T[] }>('GET', path)).items
  const id = encodeURIComponent

  return {
    me: () => send<Me>('GET', '/me'),
    workspace: {
      get: () => send<Workspace>('GET', '/workspace'),
      update: (input) => send<Workspace>('PATCH', '/workspace', input),
    },
    statuses: {
      list: () => list<Status>('/statuses'),
      create: (input) => send<Status>('POST', '/statuses', input),
      update: (statusId, input) => send<Status>('PATCH', `/statuses/${id(statusId)}`, input),
      remove: (statusId) => send<void>('DELETE', `/statuses/${id(statusId)}`),
      reorder: async (ids) => (await send<{ items: Status[] }>('PUT', '/statuses/order', { ids })).items,
    },
    labels: {
      list: () => list<Label>('/labels'),
      create: (input) => send<Label>('POST', '/labels', input),
      update: (labelId, input) => send<Label>('PATCH', `/labels/${id(labelId)}`, input),
      remove: (labelId) => send<void>('DELETE', `/labels/${id(labelId)}`),
    },
    projects: {
      list: (options) => list<Project>(`/projects${options?.includeArchived ? '?includeArchived=true' : ''}`),
      get: (projectId) => send<Project>('GET', `/projects/${id(projectId)}`),
      create: (input) => send<Project>('POST', '/projects', input),
      update: (projectId, input) => send<Project>('PATCH', `/projects/${id(projectId)}`, input),
      remove: (projectId) => send<void>('DELETE', `/projects/${id(projectId)}`),
    },
    issues: {
      list: (params) => send<IssuePage>('GET', `/issues${issueSearch(params)}`),
      get: (key) => send<Issue>('GET', `/issues/${id(key)}`),
      create: (input) => send<Issue>('POST', '/issues', input),
      update: (issueId, input) => send<Issue>('PATCH', `/issues/${id(issueId)}`, input),
      remove: (issueId) => send<void>('DELETE', `/issues/${id(issueId)}`),
      timeline: (issueId) => list<TimelineItem>(`/issues/${id(issueId)}/timeline`),
      comment: (issueId, body) => send<Comment>('POST', `/issues/${id(issueId)}/comments`, { body }),
      attach: (issueId, file) => {
        const form = new FormData()
        form.append('file', file, file.name)
        return send<Attachment>('POST', `/issues/${id(issueId)}/attachments`, form)
      },
    },
    comments: {
      update: (commentId, body) => send<Comment>('PATCH', `/comments/${id(commentId)}`, { body }),
      remove: (commentId) => send<void>('DELETE', `/comments/${id(commentId)}`),
    },
    attachments: {
      remove: (attachmentId) => send<void>('DELETE', `/attachments/${id(attachmentId)}`),
    },
    views: {
      list: () => list<View>('/views'),
      create: (input) => send<View>('POST', '/views', input),
      update: (viewId, input) => send<View>('PATCH', `/views/${id(viewId)}`, input),
      remove: (viewId) => send<void>('DELETE', `/views/${id(viewId)}`),
    },
    people: (q) => send<PeopleResult>('GET', `/people${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  }
}

function browserReauth(): boolean {
  const lastReauthAt = Number(sessionStorage.getItem(REAUTH_AT_KEY))
  if (Date.now() - lastReauthAt < REAUTH_WINDOW_MS) return false
  sessionStorage.setItem(REAUTH_AT_KEY, String(Date.now()))
  window.location.assign('/')
  return true
}

export const trackerApi = createTrackerApi()
