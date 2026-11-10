// Dev-only in-memory implementation of the tracker contract
// (`/api/tracker/v1/*`, design/API.md). Fixture shared with the server's dev
// seed (`TRACKER_DEV_SEED=1`): workspace key APT, the six default statuses,
// three people (dev-alex Alex Chen, dev-sam Sam Rivera, dev-jordan Jordan
// Lee), three labels (regression/red, ux/purple, docs/blue), three projects
// (Dashboard/blue, Platform API/purple, Builder Console/orange), 30 issues
// across every status (Alex Chen reports 10 of them, so "Reported by me" is
// not empty), then 2 epics and 4 stories (APT-31…36, In Progress) that bundle
// every seeded issue n with n % 5 != 0 under stories[n % 4], and three shared
// views (Bugs, My issues, By epic).
// The caller is Alex Chen as Team Admin; MOCK_ROLE=Editor (or Viewer) makes
// them a non-admin. `POST /api/tracker/v1/__mock/caller {sub, role?}` switches
// the signed-in person (role default Editor); a `sub` outside the seed needs a
// `name` and signs in someone who has reported and been assigned nothing.
// `POST /api/tracker/v1/__mock/reset` reseeds all state (body
// `{"projects":"none"}` reseeds without projects).
// MOCK_PROJECTS=none starts with no projects (a workspace from before v0.2,
// like the live install). MOCK_DIRECTORY=absent makes `GET /people` answer
// `source: unavailable`. The issue cursor is base64url(offset), opaque to the SPA.
import type {
  Activity,
  ActivityField,
  ApiError,
  Attachment,
  Comment,
  Filter,
  GroupBy,
  Issue,
  IssueRef,
  IssueSummary,
  IssueType,
  Label,
  LabelColor,
  Me,
  Person,
  Priority,
  Progress,
  Project,
  Report,
  Role,
  Sort,
  Status,
  StatusCategory,
  TimelineItem,
  View,
  ViewLayout,
  Workspace,
} from '../api/tracker'
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  ATTACHMENTS_PER_ISSUE,
  canParent,
  CATEGORIES,
  compareIssues,
  GROUP_BYS,
  ISSUE_TYPES,
  levelOf,
  matchesFilter,
  orderStatuses,
  PRIORITIES,
  PROJECT_DESCRIPTION_MAX_BYTES,
  PROJECT_NAME_MAX,
  REPORT_TEXT_MAX,
  SORTS,
  SURFACES,
  TITLE_MAX,
  WORK_ITEM_TYPES,
} from '../model/issues'

const BASE = '/api/tracker/v1'
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_VIEWS = 50
const PEOPLE_LIMIT = 20
/** Most subjects one `reporter` filter may name (API.md, same limit as `assignee`). */
const REPORTER_FILTER_MAX = 20
/** Ancestor walks for the derived `epic`/`story` stop after this many hops (API.md). */
const ANCESTOR_HOPS = 32
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i
const DESCRIPTION_MAX_BYTES = 51_200
const COMMENT_MAX_BYTES = 20_480
const LABEL_COLORS: readonly LabelColor[] = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink']
const FILTER_KEYS: Record<keyof Filter, true> = {
  status: true,
  category: true,
  assignee: true,
  reporter: true,
  label: true,
  type: true,
  priority: true,
  q: true,
  createdAfter: true,
  environment: true,
  surface: true,
  parent: true,
  project: true,
  epic: true,
  story: true,
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A ULID-shaped id: 48-bit time and an 80-bit tail derived from `seq`, both Crockford base32. */
function ulid(time: number, seq: number): string {
  let head = ''
  for (let value = time, i = 0; i < 10; i++, value = Math.floor(value / 32)) head = CROCKFORD[value % 32] + head
  let tail = ''
  for (let value = seq * 2654435761, i = 0; i < 16; i++, value = Math.floor(value / 32) + i * 7919) tail = CROCKFORD[value % 32] + tail
  return head + tail
}

const T0 = Date.parse('2026-10-20T00:00:00Z')
const HOUR = 3_600_000
const AVATAR_VERSION = '2026-11-10T00:00:00Z'
// A 32×32 PNG profile fixture, served through the same route as Directory photos.
const AVATAR_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAATElEQVR4nGN4eOsrTRHDqAWjFtDNgjTvfZiIahZgNZ1IOwhbgMd0YuwYtWDUAnpYgN8OgnoHR06mBA17CwgmIYKRMWrBqAWjFgwHCwBMkYSMWumRBwAAAABJRU5ErkJggg==', 'base64')

/** The seed's people, in the server seed's order (cmd/server/internal/store/seed.go). */
export const MOCK_PEOPLE = {
  alex: { sub: 'dev-alex', name: 'Alex Chen', avatarUrl: `${BASE}/people/person-alex/avatar?v=${encodeURIComponent(AVATAR_VERSION)}` },
  sam: { sub: 'dev-sam', name: 'Sam Rivera' },
  jordan: { sub: 'dev-jordan', name: 'Jordan Lee' },
} as const satisfies Record<string, Person>

export const MOCK_WORKSPACE_ID = 'pj-mock'

type StoredIssue = {
  id: string
  number: number
  title: string
  description: string
  type: IssueType
  priority: Priority
  statusId: string
  assignee: Person | null
  reporter: Person
  labelIds: string[]
  projectId: string | null
  parentId: string | null
  dueOn: string | null
  report: Report | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  deleted: boolean
}
type StoredComment = Comment & { deleted: boolean }
type StoredAttachment = Attachment & { bytes: Uint8Array<ArrayBuffer>; deleted: boolean }
type StoredProject = { id: string; name: string; description: string; color: LabelColor; archivedAt: string | null; createdAt: string; updatedAt: string }
type Block = { blockerId: string; blockedId: string }

const STATUS_SEED: readonly [string, StatusCategory, string][] = [
  ['Backlog', 'backlog', 'gray'],
  ['Todo', 'unstarted', 'gray'],
  ['In Progress', 'started', 'yellow'],
  ['In Review', 'started', 'blue'],
  ['Done', 'completed', 'green'],
  ['Canceled', 'canceled', 'gray'],
]

const LABEL_SEED: readonly [string, LabelColor][] = [
  ['regression', 'red'],
  ['ux', 'purple'],
  ['docs', 'blue'],
]

/** In this order (the server seed's); the issue → project rule below indexes it. */
const PROJECT_SEED: readonly [string, LabelColor][] = [
  ['Dashboard', 'blue'],
  ['Platform API', 'purple'],
  ['Builder Console', 'orange'],
]

/** Issue number `n` (1-based): no project when n % 3 == 0, else PROJECT_SEED[(n % 3 + n % 2) % 3]. Same rule as the server seed. */
export function seedProjectIndex(n: number): number | null {
  return n % 3 === 0 ? null : ((n % 3) + (n % 2)) % 3
}

/** Issue titles of the server seed, in order; issue `i` (0-based) gets the modulo-indexed attributes below. */
const SEED_TITLES: readonly string[] = [
  'Dashboard loses filters on reload',
  'Add keyboard shortcuts to issue list',
  'Document cluster recovery steps',
  'Platform API returns stale status',
  'Improve deployment progress display',
  'Update CLI quickstart',
  'Console app screenshot upload fails',
  'Add assignee picker search',
  'Review Gateway access documentation',
  'Cluster provisioning stalls',
  'Improve empty-state guidance',
  'Document release identity',
  'Dashboard sidebar overlaps content',
  'Add board column counts',
  'Clean up old fixtures',
  'CLI login expires too early',
  'Improve report form validation',
  'Document attachment limits',
  'Builder Console fails to load logs',
  'Add saved view navigation',
  'Review issue triage process',
  'Platform API pagination skips items',
  'Improve status colors',
  'Document Directory integration',
  'Console app reload loses state',
  'Add copy identifier action',
  'Review accessibility labels',
  'Cluster status is delayed',
  'Improve mobile issue detail',
  'Document workspace settings',
]
const SEED_ENVIRONMENTS = ['appthrust.ink', 'craftsman', 'appthrust.dev', 'local'] as const
/** API.md v0.1.6 fixture, in creation order after the seed issues (same titles and order as the server seed). */
const EPIC_SEED: readonly string[] = ['Reliable bug intake', 'Faster triage']
/** Story `s` belongs to EPIC_SEED[floor(s / 2)]. */
const STORY_SEED: readonly string[] = [
  'As a reporter, I want to submit a complete bug report',
  'As a triager, I want to reproduce reported bugs',
  'As a triager, I want to prioritize incoming work',
  'As an assignee, I want to find my next task',
]

/**
 * Mirrors the server's SeedDev: issue `i` has status i%6, type i%3 (bug,
 * feature, task), priority i%5, label i%3, reporter i%3, assignee (i+1)%3,
 * project by `seedProjectIndex(i+1)`; bugs carry a report with environment
 * i%4 and surface i%7. Then the epics and stories: In Progress, medium
 * priority, reported by Alex, unassigned, no labels, project or description;
 * seed issue n (1-based) with n % 5 != 0 gets the parent stories[n % 4].
 * Creation times are spaced one hour apart. `withProjects: false` seeds a
 * workspace without projects.
 */
function seedTracker({ withProjects = process.env.MOCK_PROJECTS !== 'none' }: { withProjects?: boolean } = {}) {
  const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString()
  let seq = 1
  const statuses: Status[] = STATUS_SEED.map(([name, category, color], position) => ({ id: ulid(T0, seq++), name, category, position, color }))
  const labels: (Label & { createdAt: string })[] = LABEL_SEED.map(([name, color]) => ({ id: ulid(T0, seq++), name, color, createdAt: at(0) }))
  const projects: StoredProject[] = withProjects
    ? PROJECT_SEED.map(([name, color]) => ({ id: ulid(T0, seq++), name, description: '', color, archivedAt: null, createdAt: at(0), updatedAt: at(0) }))
    : []
  const people = [MOCK_PEOPLE.alex, MOCK_PEOPLE.sam, MOCK_PEOPLE.jordan]
  const issues: StoredIssue[] = []
  const activities: Activity[] = []
  SEED_TITLES.forEach((title, i) => {
    const createdAt = at(i + 1)
    const status = statuses[i % statuses.length]!
    const type = WORK_ITEM_TYPES[i % WORK_ITEM_TYPES.length]!
    const issue: StoredIssue = {
      id: ulid(T0 + (i + 1) * HOUR, seq++),
      number: i + 1,
      title,
      description: `Track and investigate this AppThrust work item.\n\nFixture issue ${i + 1}.`,
      type,
      priority: PRIORITIES[i % PRIORITIES.length]!,
      statusId: status.id,
      assignee: people[(i + 1) % people.length]!,
      reporter: people[i % people.length]!,
      labelIds: [labels[i % labels.length]!.id],
      projectId: projects[seedProjectIndex(i + 1) ?? -1]?.id ?? null,
      parentId: null,
      dueOn: null,
      report:
        type === 'bug'
          ? {
              environment: SEED_ENVIRONMENTS[i % SEED_ENVIRONMENTS.length]!,
              surface: SURFACES[i % SURFACES.length]!,
              version: '0.1.0',
              steps: 'Open the affected surface and repeat the action.',
              expected: 'The action completes successfully.',
              actual: 'The observed behavior differs from the expected result.',
            }
          : null,
      createdAt,
      updatedAt: createdAt,
      completedAt: status.category === 'completed' || status.category === 'canceled' ? createdAt : null,
      deleted: false,
    }
    issues.push(issue)
    activities.push({ id: ulid(T0 + (i + 1) * HOUR, seq++), issueId: issue.id, actor: issue.reporter, field: 'created', from: null, to: null, createdAt })
  })
  const inProgress = statuses.find((status) => status.name === 'In Progress')!
  const bundle = (title: string, type: IssueType, parentId: string | null): StoredIssue => {
    const number = issues.length + 1
    const createdAt = at(number)
    const issue: StoredIssue = {
      id: ulid(T0 + number * HOUR, seq++),
      number,
      title,
      description: '',
      type,
      priority: 'medium',
      statusId: inProgress.id,
      assignee: null,
      reporter: MOCK_PEOPLE.alex,
      labelIds: [],
      projectId: null,
      parentId,
      dueOn: null,
      report: null,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      deleted: false,
    }
    issues.push(issue)
    activities.push({ id: ulid(T0 + number * HOUR, seq++), issueId: issue.id, actor: issue.reporter, field: 'created', from: null, to: null, createdAt })
    return issue
  }
  const epics = EPIC_SEED.map((title) => bundle(title, 'epic', null))
  const stories = STORY_SEED.map((title, s) => bundle(title, 'story', epics[Math.floor(s / 2)]!.id))
  issues.slice(0, SEED_TITLES.length).forEach((issue) => {
    if (issue.number % 5 !== 0) issue.parentId = stories[issue.number % 4]!.id
  })
  const views: (View & { ownerSub: string })[] = [
    { id: ulid(T0, seq++), name: 'Bugs', owner: MOCK_PEOPLE.alex, ownerSub: MOCK_PEOPLE.alex.sub, shared: true, layout: 'list', groupBy: 'none', filter: { type: ['bug'] }, sort: 'updated', position: 0, createdAt: at(0), updatedAt: at(0) },
    { id: ulid(T0, seq++), name: 'My issues', owner: MOCK_PEOPLE.alex, ownerSub: MOCK_PEOPLE.alex.sub, shared: true, layout: 'list', groupBy: 'none', filter: { assignee: ['me'] }, sort: 'updated', position: 1, createdAt: at(0), updatedAt: at(0) },
    { id: ulid(T0, seq++), name: 'By epic', owner: MOCK_PEOPLE.alex, ownerSub: MOCK_PEOPLE.alex.sub, shared: true, layout: 'board', groupBy: 'epic', filter: {}, sort: 'updated', position: 2, createdAt: at(0), updatedAt: at(0) },
  ]
  const role = process.env.MOCK_ROLE === 'Editor' || process.env.MOCK_ROLE === 'Viewer' ? (process.env.MOCK_ROLE as Role) : 'Admin'
  return {
    workspace: { id: MOCK_WORKSPACE_ID, key: 'APT', name: MOCK_WORKSPACE_ID, createdAt: at(0), updatedAt: at(0) },
    statuses,
    labels,
    projects,
    issues,
    blocks: [] as Block[],
    activities,
    comments: [] as StoredComment[],
    attachments: [] as StoredAttachment[],
    views,
    caller: MOCK_PEOPLE.alex as Person,
    role,
    clock: T0 + 100 * HOUR,
    seq: seq + 1000,
  }
}

let state = seedTracker()

/** Strictly increasing wall-clock time, so two writes in one millisecond still order. */
function now(): string {
  state.clock = Math.max(Date.now(), state.clock + 1)
  return new Date(state.clock).toISOString()
}
const nextId = () => ulid(state.clock, state.seq++)

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const fail = (status: number, error: string, message: string, issues?: ApiError['issues']) => json({ error, message, ...(issues ? { issues } : {}) } satisfies ApiError, status)
const notFound = () => fail(404, 'not_found', 'The requested resource was not found')
const forbidden = () => fail(403, 'forbidden', 'You do not have permission for this action')
const conflict = (message: string) => fail(409, 'conflict', message)
const invalid = (path: string, message: string) => fail(400, 'invalid', message, [{ path, message }])
const noContent = () => new Response(null, { status: 204 })

async function body(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await request.json()
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const isAdmin = () => state.role === 'Admin'
const bytes = (text: string) => new TextEncoder().encode(text).length
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
const live = () => state.issues.filter((issue) => !issue.deleted)

function workspace(): Workspace {
  return { ...state.workspace, issueCount: live().length }
}

function identifier(issue: StoredIssue): string {
  return `${state.workspace.key}-${issue.number}`
}

function ref(issue: StoredIssue): IssueRef {
  return { id: issue.id, identifier: identifier(issue), title: issue.title, statusId: issue.statusId }
}

function issueById(id: string | null): StoredIssue | undefined {
  return id ? state.issues.find((issue) => issue.id === id && !issue.deleted) : undefined
}

/** The nearest strict ancestor of `type`, walking at most ANCESTOR_HOPS parents. */
function ancestorOfType(issue: StoredIssue, type: IssueType): StoredIssue | undefined {
  let cursor = issueById(issue.parentId)
  for (let hops = 0; cursor && hops < ANCESTOR_HOPS; hops++, cursor = issueById(cursor.parentId)) {
    if (cursor.type === type) return cursor
  }
  return undefined
}

/** Epics and stories: over all live level-0 descendants, `total` excludes canceled ones, `completed` counts completed ones. */
function progressOf(issue: StoredIssue): Progress | null {
  if (levelOf(issue.type) === 0) return null
  const category = (statusId: string) => state.statuses.find((status) => status.id === statusId)?.category
  const progress: Progress = { total: 0, completed: 0 }
  const seen = new Set<string>([issue.id])
  for (let frontier = [issue.id]; frontier.length > 0; ) {
    const children = live().filter((candidate) => candidate.parentId !== null && frontier.includes(candidate.parentId) && !seen.has(candidate.id))
    for (const child of children) {
      seen.add(child.id)
      if (levelOf(child.type) !== 0 || category(child.statusId) === 'canceled') continue
      progress.total++
      if (category(child.statusId) === 'completed') progress.completed++
    }
    frontier = children.map((child) => child.id)
  }
  return progress
}

function summary(issue: StoredIssue): IssueSummary {
  const parent = issueById(issue.parentId)
  const epic = ancestorOfType(issue, 'epic')
  const story = ancestorOfType(issue, 'story')
  return {
    id: issue.id,
    identifier: identifier(issue),
    number: issue.number,
    title: issue.title,
    type: issue.type,
    priority: issue.priority,
    statusId: issue.statusId,
    assignee: issue.assignee,
    reporter: issue.reporter,
    labelIds: [...issue.labelIds],
    projectId: issue.projectId,
    parent: parent ? ref(parent) : null,
    epic: epic ? ref(epic) : null,
    story: story ? ref(story) : null,
    progress: progressOf(issue),
    dueOn: issue.dueOn,
    report: issue.report,
    commentCount: state.comments.filter((comment) => comment.issueId === issue.id && !comment.deleted).length,
    attachmentCount: state.attachments.filter((attachment) => attachment.issueId === issue.id && !attachment.deleted).length,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    completedAt: issue.completedAt,
  }
}

function full(issue: StoredIssue): Issue {
  const refs = (ids: string[]) => ids.map(issueById).filter((found): found is StoredIssue => found !== undefined).sort((a, b) => a.number - b.number).map(ref)
  return {
    ...summary(issue),
    description: issue.description,
    children: refs(live().filter((child) => child.parentId === issue.id).map((child) => child.id)),
    blocks: refs(state.blocks.filter((block) => block.blockerId === issue.id).map((block) => block.blockedId)),
    blockedBy: refs(state.blocks.filter((block) => block.blockedId === issue.id).map((block) => block.blockerId)),
  }
}

/** `APT-12` (any case, current key) or ULID. */
function findIssue(key: string): StoredIssue | undefined {
  const match = key.match(/^([A-Za-z][A-Za-z0-9]{1,5})-(\d+)$/)
  if (match) {
    if (match[1]!.toUpperCase() !== state.workspace.key) return undefined
    return live().find((issue) => issue.number === Number(match[2]))
  }
  return issueById(key)
}

function personFor(sub: string): Person {
  return Object.values(MOCK_PEOPLE).find((person) => person.sub === sub) ?? { sub, name: sub }
}

function record(issue: StoredIssue, field: ActivityField, from: unknown, to: unknown, createdAt: string) {
  state.activities.push({ id: nextId(), issueId: issue.id, actor: state.caller, field, from, to, createdAt })
}

function closedStatus(statusId: string): boolean {
  const category = state.statuses.find((status) => status.id === statusId)?.category
  return category === 'completed' || category === 'canceled'
}

function attachmentView({ bytes: _bytes, deleted: _deleted, ...attachment }: StoredAttachment): Attachment {
  return attachment
}

function projectView(project: StoredProject): Project {
  const issues = live().filter((issue) => issue.projectId === project.id)
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    color: project.color,
    archived: project.archivedAt !== null,
    issueCount: issues.length,
    openIssueCount: issues.filter((issue) => !closedStatus(issue.statusId)).length,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

// --- validation -------------------------------------------------------------

type Problem = { path: string; message: string }

function reportProblem(value: unknown): Problem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { path: 'report', message: 'report must be an object' }
  const report = value as Record<string, unknown>
  if (typeof report.environment !== 'string' || !report.environment.trim()) return { path: 'report.environment', message: 'environment is required' }
  if (!SURFACES.includes(report.surface as never)) return { path: 'report.surface', message: `surface must be one of ${SURFACES.join(', ')}` }
  for (const key of ['environment', 'version', 'steps', 'expected', 'actual'] as const) {
    const text = report[key]
    if (text === undefined) continue
    if (typeof text !== 'string') return { path: `report.${key}`, message: `${key} must be a string` }
    if (text.length > REPORT_TEXT_MAX) return { path: `report.${key}`, message: `${key} must be at most ${REPORT_TEXT_MAX} characters` }
  }
  for (const key of Object.keys(report)) {
    if (!['environment', 'surface', 'version', 'steps', 'expected', 'actual'].includes(key)) return { path: `report.${key}`, message: `unknown field ${key}` }
  }
  return undefined
}

function cleanReport(value: Record<string, unknown>): Report {
  const report: Report = { environment: String(value.environment).trim(), surface: value.surface as Report['surface'] }
  for (const key of ['version', 'steps', 'expected', 'actual'] as const) {
    if (typeof value[key] === 'string' && value[key]) report[key] = value[key] as string
  }
  return report
}

function titleProblem(value: unknown): Problem | undefined {
  if (typeof value !== 'string' || !value.trim()) return { path: 'title', message: 'title is required' }
  if (Array.from(value.trim()).length > TITLE_MAX) return { path: 'title', message: `title must be at most ${TITLE_MAX} characters` }
  return undefined
}

/** True when making `parentId` the parent of `issueId` would close a cycle. */
function parentCycle(issueId: string, parentId: string): boolean {
  for (let cursor: StoredIssue | undefined = issueById(parentId); cursor; cursor = issueById(cursor.parentId)) {
    if (cursor.id === issueId) return true
  }
  return false
}

/** `projectId` on an issue write: null clears; unknown or archived is refused unless it is the issue's current project (an unchanged archived project). */
function projectRefProblem(value: unknown, current: string | null): Problem | undefined {
  if (value === null || value === current) return undefined
  if (typeof value !== 'string') return { path: 'projectId', message: 'projectId must be a string or null' }
  const project = state.projects.find((candidate) => candidate.id === value)
  if (!project) return { path: 'projectId', message: 'unknown project' }
  if (project.archivedAt !== null) return { path: 'projectId', message: 'project is archived' }
  return undefined
}

function projectInputProblem(input: Record<string, unknown>, creating: boolean): Problem | undefined {
  const known = creating ? ['name', 'description', 'color'] : ['name', 'description', 'color', 'archived']
  const unknownKey = Object.keys(input).find((key) => !known.includes(key))
  if (unknownKey) return { path: unknownKey, message: `unknown field ${unknownKey}` }
  if (creating || 'name' in input) {
    if (typeof input.name !== 'string' || !input.name.trim() || Array.from(input.name.trim()).length > PROJECT_NAME_MAX) return { path: 'name', message: `name must be 1–${PROJECT_NAME_MAX} characters` }
  }
  if ('description' in input && (typeof input.description !== 'string' || bytes(input.description) > PROJECT_DESCRIPTION_MAX_BYTES))
    return { path: 'description', message: `description must be at most ${PROJECT_DESCRIPTION_MAX_BYTES} bytes` }
  if ('color' in input && !LABEL_COLORS.includes(input.color as LabelColor)) return { path: 'color', message: 'unknown color' }
  if ('archived' in input && typeof input.archived !== 'boolean') return { path: 'archived', message: 'archived must be a boolean' }
  return undefined
}

/** Why an issue of `childType` cannot sit under its parent (same wording as the server's domain.ValidateHierarchy). */
function hierarchyMessage(childType: IssueType): string {
  return childType === 'epic' ? 'Epics cannot have a parent' : 'Stories can only have an epic parent'
}

function parseFilter(raw: string | null): Filter | Problem {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { path: 'filter', message: 'filter must be JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { path: 'filter', message: 'filter must be an object' }
  const filter = parsed as Record<string, unknown>
  for (const [key, value] of Object.entries(filter)) {
    if (!Object.hasOwn(FILTER_KEYS, key)) return { path: `filter.${key}`, message: `unknown filter ${key}` }
    const scalar = key === 'q' || key === 'createdAfter' || key === 'parent'
    if (scalar ? typeof value !== 'string' : !isStringArray(value)) return { path: `filter.${key}`, message: `${key} has the wrong type` }
  }
  const enumProblem = (key: string, allowed: readonly string[]) =>
    (filter[key] as string[] | undefined)?.some((value) => !allowed.includes(value)) ? { path: `filter.${key}`, message: `${key} must be one of ${allowed.join(', ')}` } : undefined
  const problem = enumProblem('category', CATEGORIES) ?? enumProblem('type', ISSUE_TYPES) ?? enumProblem('priority', PRIORITIES) ?? enumProblem('surface', SURFACES)
  if (problem) return problem
  const reporter = filter.reporter as string[] | undefined
  if (reporter && (reporter.length > REPORTER_FILTER_MAX || reporter.some((value) => value.length === 0 || value.length > 4096)))
    return { path: 'filter.reporter', message: `reporter must list at most ${REPORTER_FILTER_MAX} subjects of 1 to 4096 characters` }
  if (typeof filter.createdAfter === 'string' && Number.isNaN(Date.parse(filter.createdAfter))) return { path: 'filter.createdAfter', message: 'createdAfter must be RFC 3339' }
  for (const key of ['epic', 'story'] as const) {
    if ((filter[key] as string[] | undefined)?.some((value) => value !== 'none' && !ULID_PATTERN.test(value))) return { path: `filter.${key}`, message: `${key} must list issue ids or none` }
  }
  return filter as Filter
}

function isProblem(value: unknown): value is Problem {
  return typeof value === 'object' && value !== null && 'path' in value && 'message' in value && Object.keys(value).length === 2
}

// --- handlers ---------------------------------------------------------------

function listIssues(url: URL): Response {
  const filter = parseFilter(url.searchParams.get('filter'))
  if (isProblem(filter)) return invalid(filter.path, filter.message)
  const sort = (url.searchParams.get('sort') ?? 'updated') as Sort
  if (!SORTS.includes(sort)) return invalid('sort', `sort must be one of ${SORTS.join(', ')}`)
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam === null ? DEFAULT_LIMIT : Number(limitParam)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return invalid('limit', `limit must be between 1 and ${MAX_LIMIT}`)
  const cursorParam = url.searchParams.get('cursor')
  const offset = cursorParam ? Number(Buffer.from(cursorParam, 'base64url').toString('utf8')) : 0
  if (!Number.isInteger(offset) || offset < 0) return invalid('cursor', 'cursor is not valid')
  const descriptions = new Map(state.issues.map((issue) => [issue.id, issue.description]))
  const matching = live()
    .map(summary)
    .filter((issue) => matchesFilter(issue, filter, { me: state.caller.sub, statuses: state.statuses, description: (candidate) => descriptions.get(candidate.id) ?? '' }))
    .sort(compareIssues(sort))
  const page = matching.slice(offset, offset + limit)
  const next = offset + limit < matching.length ? Buffer.from(String(offset + limit), 'utf8').toString('base64url') : null
  return json({ items: page, nextCursor: next })
}

async function createIssue(request: Request): Promise<Response> {
  const input = await body(request)
  if (!input) return invalid('', 'A JSON object is required')
  const title = titleProblem(input.title)
  if (title) return invalid(title.path, title.message)
  if (!ISSUE_TYPES.includes(input.type as IssueType)) return invalid('type', `type must be one of ${ISSUE_TYPES.join(', ')}`)
  const type = input.type as IssueType
  if (type === 'bug') {
    const problem = reportProblem(input.report)
    if (problem) return invalid(problem.path, problem.message)
  } else if (input.report !== undefined && input.report !== null) return invalid('report', 'report is only allowed on bugs')
  if (input.description !== undefined && (typeof input.description !== 'string' || bytes(input.description) > DESCRIPTION_MAX_BYTES)) return invalid('description', 'description must be at most 50 KiB')
  if (input.priority !== undefined && !PRIORITIES.includes(input.priority as Priority)) return invalid('priority', 'unknown priority')
  const backlog = orderStatuses(state.statuses).find((status) => status.category === 'backlog')!
  const statusId = typeof input.statusId === 'string' ? input.statusId : backlog.id
  if (!state.statuses.some((status) => status.id === statusId)) return invalid('statusId', 'unknown status')
  if (input.assigneeSub !== undefined && input.assigneeSub !== null && typeof input.assigneeSub !== 'string') return invalid('assigneeSub', 'assigneeSub must be a string')
  if (input.labelIds !== undefined && (!isStringArray(input.labelIds) || input.labelIds.some((id) => !state.labels.some((label) => label.id === id)))) return invalid('labelIds', 'unknown label')
  if (input.parentId !== undefined && input.parentId !== null && (typeof input.parentId !== 'string' || !issueById(input.parentId))) return invalid('parentId', 'unknown parent')
  const parent = issueById((input.parentId as string | null | undefined) ?? null)
  if (parent && !canParent(type, parent.type)) return invalid('parentId', hierarchyMessage(type))
  if (input.dueOn !== undefined && input.dueOn !== null && (typeof input.dueOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn))) return invalid('dueOn', 'dueOn must be YYYY-MM-DD')
  if (input.projectId !== undefined) {
    const problem = projectRefProblem(input.projectId, null)
    if (problem) return invalid(problem.path, problem.message)
  }
  const time = now()
  const number = Math.max(0, ...state.issues.map((issue) => issue.number)) + 1
  const issue: StoredIssue = {
    id: nextId(),
    number,
    title: (input.title as string).trim(),
    description: (input.description as string | undefined) ?? '',
    type,
    priority: (input.priority as Priority | undefined) ?? 'none',
    statusId,
    assignee: typeof input.assigneeSub === 'string' ? personFor(input.assigneeSub) : null,
    reporter: state.caller,
    labelIds: [...new Set((input.labelIds as string[] | undefined) ?? [])],
    projectId: typeof input.projectId === 'string' ? input.projectId : null,
    parentId: (input.parentId as string | undefined) ?? null,
    dueOn: (input.dueOn as string | undefined) ?? null,
    report: type === 'bug' ? cleanReport(input.report as Record<string, unknown>) : null,
    createdAt: time,
    updatedAt: time,
    completedAt: closedStatus(statusId) ? time : null,
    deleted: false,
  }
  state.issues.push(issue)
  record(issue, 'created', null, null, time)
  return json(full(issue), 201)
}

async function updateIssue(issue: StoredIssue, request: Request): Promise<Response> {
  const input = await body(request)
  if (!input) return invalid('', 'A JSON object is required')
  const known = ['title', 'description', 'type', 'priority', 'statusId', 'assigneeSub', 'labelIds', 'parentId', 'blocks', 'dueOn', 'report', 'projectId']
  const unknownKey = Object.keys(input).find((key) => !known.includes(key))
  if (unknownKey) return invalid(unknownKey, `unknown field ${unknownKey}`)
  if ('title' in input) {
    const problem = titleProblem(input.title)
    if (problem) return invalid(problem.path, problem.message)
  }
  if ('description' in input && (typeof input.description !== 'string' || bytes(input.description) > DESCRIPTION_MAX_BYTES)) return invalid('description', 'description must be at most 50 KiB')
  if ('type' in input && !ISSUE_TYPES.includes(input.type as IssueType)) return invalid('type', 'unknown type')
  if ('priority' in input && !PRIORITIES.includes(input.priority as Priority)) return invalid('priority', 'unknown priority')
  if ('statusId' in input && !state.statuses.some((status) => status.id === input.statusId)) return invalid('statusId', 'unknown status')
  if ('assigneeSub' in input && input.assigneeSub !== null && typeof input.assigneeSub !== 'string') return invalid('assigneeSub', 'assigneeSub must be a string or null')
  if ('labelIds' in input && (!isStringArray(input.labelIds) || input.labelIds.some((id) => !state.labels.some((label) => label.id === id)))) return invalid('labelIds', 'unknown label')
  if ('parentId' in input && input.parentId !== null) {
    if (typeof input.parentId !== 'string' || !issueById(input.parentId)) return invalid('parentId', 'unknown parent')
    if (input.parentId === issue.id || parentCycle(issue.id, input.parentId)) return invalid('parentId', 'parent would create a cycle')
  }
  if ('blocks' in input) {
    if (!isStringArray(input.blocks) || input.blocks.some((id) => !issueById(id))) return invalid('blocks', 'unknown issue')
    if (input.blocks.includes(issue.id)) return invalid('blocks', 'an issue cannot block itself')
    if (input.blocks.some((id) => state.blocks.some((block) => block.blockerId === id && block.blockedId === issue.id))) return invalid('blocks', 'blocking would create a cycle')
  }
  if ('dueOn' in input && input.dueOn !== null && (typeof input.dueOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn))) return invalid('dueOn', 'dueOn must be YYYY-MM-DD')
  if ('projectId' in input) {
    const problem = projectRefProblem(input.projectId, issue.projectId)
    if (problem) return invalid(problem.path, problem.message)
  }
  const nextType = (input.type as IssueType | undefined) ?? issue.type
  if ('report' in input && input.report !== null) {
    const problem = reportProblem(input.report)
    if (problem) return invalid(problem.path, problem.message)
  }
  const nextReport = nextType !== 'bug' ? null : 'report' in input ? (input.report === null ? null : cleanReport(input.report as Record<string, unknown>)) : issue.report
  if (nextType === 'bug' && !nextReport) return invalid('report', 'report is required for bugs')
  if (nextType !== 'bug' && 'report' in input && input.report !== null) return invalid('report', 'report is only allowed on bugs')
  // Hierarchy (API.md): the issue against its (new) parent, and its direct children against its new type.
  const parentChanged = 'parentId' in input && (input.parentId ?? null) !== issue.parentId
  const nextParent = issueById('parentId' in input ? ((input.parentId as string | null) ?? null) : issue.parentId)
  if ((parentChanged || nextType !== issue.type) && nextParent && !canParent(nextType, nextParent.type)) return invalid(parentChanged ? 'parentId' : 'type', hierarchyMessage(nextType))
  if (nextType !== issue.type) {
    const misfit = live().find((child) => child.parentId === issue.id && !canParent(child.type, nextType))
    if (misfit) return invalid('type', `${identifier(misfit)}: ${hierarchyMessage(misfit.type)}`)
  }

  const time = now()
  let changed = false
  const change = (field: ActivityField, from: unknown, to: unknown) => {
    record(issue, field, from, to, time)
    changed = true
  }
  if ('title' in input && (input.title as string).trim() !== issue.title) {
    change('title', issue.title, (input.title as string).trim())
    issue.title = (input.title as string).trim()
  }
  if ('description' in input && input.description !== issue.description) {
    change('description', issue.description, input.description)
    issue.description = input.description as string
  }
  if (nextType !== issue.type) {
    change('type', issue.type, nextType)
    issue.type = nextType
  }
  if (JSON.stringify(nextReport) !== JSON.stringify(issue.report)) {
    change('report', issue.report, nextReport)
    issue.report = nextReport
  }
  if ('priority' in input && input.priority !== issue.priority) {
    change('priority', issue.priority, input.priority)
    issue.priority = input.priority as Priority
  }
  if ('statusId' in input && input.statusId !== issue.statusId) {
    change('status', issue.statusId, input.statusId)
    issue.statusId = input.statusId as string
    issue.completedAt = closedStatus(issue.statusId) ? time : null
  }
  if ('assigneeSub' in input && (input.assigneeSub ?? null) !== (issue.assignee?.sub ?? null)) {
    const next = typeof input.assigneeSub === 'string' ? personFor(input.assigneeSub) : null
    change('assignee', issue.assignee, next)
    issue.assignee = next
  }
  if ('labelIds' in input) {
    const next = [...new Set(input.labelIds as string[])]
    if ([...next].sort().join() !== [...issue.labelIds].sort().join()) {
      change('labels', issue.labelIds, next)
      issue.labelIds = next
    }
  }
  if ('parentId' in input && (input.parentId ?? null) !== issue.parentId) {
    const before = issueById(issue.parentId)
    const after = issueById((input.parentId as string | null) ?? null)
    change('parent', before ? ref(before) : null, after ? ref(after) : null)
    issue.parentId = (input.parentId as string | null) ?? null
  }
  if ('blocks' in input) {
    const before = state.blocks.filter((block) => block.blockerId === issue.id).map((block) => block.blockedId)
    const after = [...new Set(input.blocks as string[])]
    if ([...before].sort().join() !== [...after].sort().join()) {
      const refs = (ids: string[]) => ids.map(issueById).filter((found): found is StoredIssue => found !== undefined).map(ref)
      change('blocks', refs(before), refs(after))
      state.blocks = [...state.blocks.filter((block) => block.blockerId !== issue.id), ...after.map((blockedId) => ({ blockerId: issue.id, blockedId }))]
    }
  }
  if ('dueOn' in input && (input.dueOn ?? null) !== issue.dueOn) {
    change('due', issue.dueOn, input.dueOn ?? null)
    issue.dueOn = (input.dueOn as string | null) ?? null
  }
  if ('projectId' in input && (input.projectId ?? null) !== issue.projectId) {
    const next = (input.projectId as string | null) ?? null
    change('project', issue.projectId, next)
    issue.projectId = next
  }
  if (changed) issue.updatedAt = time
  return json(full(issue))
}

function timeline(issue: StoredIssue): Response {
  const items: TimelineItem[] = [
    ...state.activities.filter((activity) => activity.issueId === issue.id).map((activity): TimelineItem => ({ kind: 'activity', activity })),
    ...state.comments
      .filter((comment) => comment.issueId === issue.id && !comment.deleted)
      .map(({ deleted: _deleted, ...comment }): TimelineItem => ({ kind: 'comment', comment })),
  ]
  const at = (item: TimelineItem) => (item.kind === 'activity' ? item.activity.createdAt : item.comment.createdAt)
  const id = (item: TimelineItem) => (item.kind === 'activity' ? item.activity.id : item.comment.id)
  items.sort((a, b) => at(a).localeCompare(at(b)) || id(a).localeCompare(id(b)))
  return json({ items })
}

async function attach(issue: StoredIssue, request: Request): Promise<Response> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return invalid('file', 'multipart form data with a file is required')
  }
  const file = form.get('file')
  if (!(file instanceof Blob)) return invalid('file', 'file is required')
  const existing = state.attachments.filter((attachment) => attachment.issueId === issue.id && !attachment.deleted).length
  if (existing >= ATTACHMENTS_PER_ISSUE) return invalid('file', `at most ${ATTACHMENTS_PER_ISSUE} attachments per issue`)
  const mediaType = file.type.split(';')[0]!.trim()
  if (!ATTACHMENT_TYPES.includes(mediaType)) return invalid('file', `media type must be one of ${ATTACHMENT_TYPES.join(', ')}`)
  if (file.size === 0 || file.size > ATTACHMENT_MAX_BYTES) return invalid('file', 'file must be 1 byte to 2 MiB')
  const id = nextId()
  const filename = (file instanceof File && file.name ? file.name : 'attachment').slice(0, 200)
  const stored: StoredAttachment = {
    id,
    issueId: issue.id,
    filename,
    mediaType,
    size: file.size,
    url: `${BASE}/attachments/${id}`,
    uploader: state.caller,
    createdAt: now(),
    bytes: new Uint8Array(await file.arrayBuffer()),
    deleted: false,
  }
  state.attachments.push(stored)
  record(issue, 'attachment', null, attachmentView(stored), stored.createdAt)
  issue.updatedAt = stored.createdAt
  return json(attachmentView(stored), 201)
}

function viewsVisible() {
  return state.views.filter((view) => view.shared || view.ownerSub === state.caller.sub).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
}

function viewOut({ ownerSub: _ownerSub, ...view }: View & { ownerSub: string }): View {
  return view
}

function viewProblem(input: Record<string, unknown>, creating: boolean): Problem | undefined {
  if (creating || 'name' in input) {
    if (typeof input.name !== 'string' || !input.name.trim()) return { path: 'name', message: 'name is required' }
    if (Array.from(input.name.trim()).length > 60) return { path: 'name', message: 'name must be at most 60 characters' }
  }
  if ('layout' in input && input.layout !== 'list' && input.layout !== 'board') return { path: 'layout', message: 'layout must be list or board' }
  if ('groupBy' in input && !GROUP_BYS.includes(input.groupBy as GroupBy)) return { path: 'groupBy', message: `groupBy must be one of ${GROUP_BYS.join(', ')}` }
  if ('sort' in input && !SORTS.includes(input.sort as Sort)) return { path: 'sort', message: 'unknown sort' }
  if ('shared' in input && typeof input.shared !== 'boolean') return { path: 'shared', message: 'shared must be a boolean' }
  if ('filter' in input) {
    const filter = parseFilter(JSON.stringify(input.filter ?? null))
    if (isProblem(filter)) return filter
  }
  return undefined
}

function renumberStatuses() {
  orderStatuses(state.statuses).forEach((status, position) => (status.position = position))
}

/** Handles `/api/tracker/v1/*`; undefined for any other path. */
export async function trackerRoutes(request: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith(`${BASE}/`)) return undefined
  const route = `${request.method} ${url.pathname.slice(BASE.length)}`
  let match: RegExpMatchArray | null

  if (route === 'POST /__mock/reset') {
    const input = await body(request)
    state = seedTracker(input?.projects === 'none' ? { withProjects: false } : {})
    return json({ reset: true })
  }
  if (route === 'POST /__mock/caller') {
    const input = await body(request)
    const seeded = Object.values(MOCK_PEOPLE).find((candidate) => candidate.sub === input?.sub)
    const newcomer = typeof input?.sub === 'string' && input.sub && typeof input.name === 'string' && input.name.trim() ? { sub: input.sub, name: input.name.trim() } : undefined
    const person = seeded ?? newcomer
    if (!person) return invalid('sub', 'sub must name a seeded person, or come with a name')
    state.caller = person
    state.role = input?.role === 'Admin' || input?.role === 'Viewer' ? input.role : 'Editor'
    return json({ sub: person.sub, role: state.role })
  }
  if (route === 'GET /openapi.json') {
    const document = Bun.file(new URL('../../../cmd/server/internal/api/openapi.json', import.meta.url))
    return (await document.exists()) ? new Response(document, { headers: { 'Content-Type': 'application/json' } }) : json({ openapi: '3.1.0', info: { title: 'tracker', version: 'mock' }, paths: {} })
  }

  if (route === 'GET /me') return json({ ...state.caller, role: state.role, isAdmin: isAdmin() } satisfies Me)

  // Workspace
  if (route === 'GET /workspace') return json(workspace())
  if (route === 'PATCH /workspace') {
    if (!isAdmin()) return forbidden()
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    if ('key' in input && (typeof input.key !== 'string' || !/^[A-Z][A-Z0-9]{1,5}$/.test(input.key))) return invalid('key', 'key must match ^[A-Z][A-Z0-9]{1,5}$')
    if ('name' in input && (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100)) return invalid('name', 'name must be 1–100 characters')
    if (typeof input.key === 'string') state.workspace.key = input.key
    if (typeof input.name === 'string') state.workspace.name = input.name.trim()
    state.workspace.updatedAt = now()
    return json(workspace())
  }

  // Statuses
  if (route === 'GET /statuses') return json({ items: orderStatuses(state.statuses) })
  if (route === 'POST /statuses') {
    if (!isAdmin()) return forbidden()
    const input = await body(request)
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40) return invalid('name', 'name must be 1–40 characters')
    if (!CATEGORIES.includes(input.category as StatusCategory)) return invalid('category', 'unknown category')
    if (input.color !== undefined && !LABEL_COLORS.includes(input.color as LabelColor)) return invalid('color', 'unknown color')
    const name = input.name.trim()
    if (state.statuses.some((status) => status.name.toLowerCase() === name.toLowerCase())) return conflict('a status with this name exists')
    const category = input.category as StatusCategory
    const inCategory = state.statuses.filter((status) => status.category === category)
    const status: Status = { id: nextId(), name, category, position: Math.max(-1, ...inCategory.map((s) => s.position)) + 0.5, color: (input.color as string | undefined) ?? 'gray' }
    state.statuses.push(status)
    renumberStatuses()
    return json(status, 201)
  }
  if (route === 'PUT /statuses/order') {
    if (!isAdmin()) return forbidden()
    const input = await body(request)
    const ids = input?.ids
    if (!isStringArray(ids) || ids.length !== state.statuses.length || new Set(ids).size !== ids.length || ids.some((id) => !state.statuses.some((s) => s.id === id)))
      return invalid('ids', 'ids must list every status exactly once')
    const categories = ids.map((id) => CATEGORIES.indexOf(state.statuses.find((status) => status.id === id)!.category))
    if (categories.some((category, index) => index > 0 && category < categories[index - 1]!)) return invalid('ids', 'statuses must stay grouped by category')
    ids.forEach((id, position) => (state.statuses.find((status) => status.id === id)!.position = position))
    return json({ items: orderStatuses(state.statuses) })
  }
  if ((match = route.match(/^(PATCH|DELETE) \/statuses\/([^/]+)$/))) {
    const [, method, rawId] = match
    const status = state.statuses.find((candidate) => candidate.id === decodeURIComponent(rawId!))
    if (!status) return notFound()
    if (!isAdmin()) return forbidden()
    if (method === 'DELETE') {
      if (live().some((issue) => issue.statusId === status.id)) return conflict('move the issues in this status first')
      if (state.statuses.filter((candidate) => candidate.category === status.category).length === 1) return conflict('each category keeps at least one status')
      state.statuses = state.statuses.filter((candidate) => candidate !== status)
      renumberStatuses()
      return noContent()
    }
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    if ('category' in input) return invalid('category', 'category is immutable')
    if ('name' in input && (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40)) return invalid('name', 'name must be 1–40 characters')
    if ('color' in input && !LABEL_COLORS.includes(input.color as LabelColor)) return invalid('color', 'unknown color')
    if (typeof input.name === 'string' && state.statuses.some((other) => other !== status && other.name.toLowerCase() === (input.name as string).trim().toLowerCase())) return conflict('a status with this name exists')
    if (typeof input.name === 'string') status.name = input.name.trim()
    if (typeof input.color === 'string') status.color = input.color
    return json(status)
  }

  // Labels
  if (route === 'GET /labels') return json({ items: [...state.labels].sort((a, b) => a.name.localeCompare(b.name)).map(({ createdAt: _createdAt, ...label }) => label) })
  if (route === 'POST /labels') {
    if (!isAdmin()) return forbidden()
    const input = await body(request)
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40) return invalid('name', 'name must be 1–40 characters')
    if (!LABEL_COLORS.includes(input.color as LabelColor)) return invalid('color', 'unknown color')
    const name = input.name.trim()
    if (state.labels.some((label) => label.name.toLowerCase() === name.toLowerCase())) return conflict('a label with this name exists')
    const label = { id: nextId(), name, color: input.color as LabelColor, createdAt: now() }
    state.labels.push(label)
    return json({ id: label.id, name: label.name, color: label.color } satisfies Label, 201)
  }
  if ((match = route.match(/^(PATCH|DELETE) \/labels\/([^/]+)$/))) {
    const [, method, rawId] = match
    const label = state.labels.find((candidate) => candidate.id === decodeURIComponent(rawId!))
    if (!label) return notFound()
    if (!isAdmin()) return forbidden()
    if (method === 'DELETE') {
      state.labels = state.labels.filter((candidate) => candidate !== label)
      for (const issue of state.issues) issue.labelIds = issue.labelIds.filter((id) => id !== label.id)
      return noContent()
    }
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    if ('name' in input && (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40)) return invalid('name', 'name must be 1–40 characters')
    if ('color' in input && !LABEL_COLORS.includes(input.color as LabelColor)) return invalid('color', 'unknown color')
    if (typeof input.name === 'string' && state.labels.some((other) => other !== label && other.name.toLowerCase() === (input.name as string).trim().toLowerCase())) return conflict('a label with this name exists')
    if (typeof input.name === 'string') label.name = input.name.trim()
    if (typeof input.color === 'string') label.color = input.color as LabelColor
    return json({ id: label.id, name: label.name, color: label.color } satisfies Label)
  }

  // Projects (any caller writes; archiving and deleting are Admin only)
  if (route === 'GET /projects') {
    const includeArchived = url.searchParams.get('includeArchived') === 'true'
    const items = state.projects.filter((project) => includeArchived || project.archivedAt === null).sort((a, b) => a.name.localeCompare(b.name))
    return json({ items: items.map(projectView) })
  }
  if (route === 'POST /projects') {
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    const problem = projectInputProblem(input, true)
    if (problem) return invalid(problem.path, problem.message)
    const name = (input.name as string).trim()
    if (state.projects.some((project) => project.name === name)) return conflict('a project with this name exists')
    const time = now()
    const project: StoredProject = { id: nextId(), name, description: (input.description as string | undefined) ?? '', color: (input.color as LabelColor | undefined) ?? 'gray', archivedAt: null, createdAt: time, updatedAt: time }
    state.projects.push(project)
    return json(projectView(project), 201)
  }
  if ((match = route.match(/^(GET|PATCH|DELETE) \/projects\/([^/]+)$/))) {
    const [, method, rawId] = match
    const project = state.projects.find((candidate) => candidate.id === decodeURIComponent(rawId!))
    if (!project) return notFound()
    if (method === 'GET') return json(projectView(project))
    if (method === 'DELETE') {
      if (!isAdmin()) return forbidden()
      if (live().some((issue) => issue.projectId === project.id)) return conflict('issues still belong to this project; archive it instead')
      for (const issue of state.issues) if (issue.projectId === project.id) issue.projectId = null
      state.projects = state.projects.filter((candidate) => candidate !== project)
      return noContent()
    }
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    if ('archived' in input && !isAdmin()) return forbidden()
    const problem = projectInputProblem(input, false)
    if (problem) return invalid(problem.path, problem.message)
    if (typeof input.name === 'string' && state.projects.some((other) => other !== project && other.name === (input.name as string).trim())) return conflict('a project with this name exists')
    if (typeof input.name === 'string') project.name = input.name.trim()
    if (typeof input.description === 'string') project.description = input.description
    if (typeof input.color === 'string') project.color = input.color as LabelColor
    if (typeof input.archived === 'boolean' && input.archived !== (project.archivedAt !== null)) project.archivedAt = input.archived ? now() : null
    project.updatedAt = now()
    return json(projectView(project))
  }

  // Issues
  if (route === 'GET /issues') return listIssues(url)
  if (route === 'POST /issues') return createIssue(request)
  if ((match = route.match(/^GET \/issues\/([^/]+)$/))) {
    const issue = findIssue(decodeURIComponent(match[1]!))
    return issue ? json(full(issue)) : notFound()
  }
  if ((match = route.match(/^(PATCH|DELETE) \/issues\/([^/]+)$/))) {
    const [, method, rawId] = match
    const issue = issueById(decodeURIComponent(rawId!))
    if (!issue) return notFound()
    if (method === 'PATCH') return updateIssue(issue, request)
    if (!isAdmin()) return forbidden()
    const time = now()
    record(issue, 'deleted', null, null, time)
    issue.deleted = true
    issue.updatedAt = time
    return noContent()
  }
  if ((match = route.match(/^(GET|POST) \/issues\/([^/]+)\/(timeline|comments|attachments)$/))) {
    const [, method, rawId, sub] = match
    const issue = issueById(decodeURIComponent(rawId!))
    if (!issue) return notFound()
    if (method === 'GET' && sub === 'timeline') return timeline(issue)
    if (method === 'POST' && sub === 'comments') {
      const input = await body(request)
      if (typeof input?.body !== 'string' || !input.body.trim()) return invalid('body', 'body is required')
      if (bytes(input.body) > COMMENT_MAX_BYTES) return invalid('body', 'body must be at most 20 KiB')
      const comment: StoredComment = { id: nextId(), issueId: issue.id, author: state.caller, body: input.body, createdAt: now(), editedAt: null, deleted: false }
      state.comments.push(comment)
      issue.updatedAt = comment.createdAt
      const { deleted: _deleted, ...out } = comment
      return json(out satisfies Comment, 201)
    }
    if (method === 'POST' && sub === 'attachments') return attach(issue, request)
    return notFound()
  }

  // Comments
  if ((match = route.match(/^(PATCH|DELETE) \/comments\/([^/]+)$/))) {
    const [, method, rawId] = match
    const comment = state.comments.find((candidate) => candidate.id === decodeURIComponent(rawId!) && !candidate.deleted)
    if (!comment || !issueById(comment.issueId)) return notFound()
    const mine = comment.author.sub === state.caller.sub
    if (method === 'DELETE') {
      if (!mine && !isAdmin()) return forbidden()
      comment.deleted = true
      return noContent()
    }
    if (!mine) return forbidden()
    const input = await body(request)
    if (typeof input?.body !== 'string' || !input.body.trim()) return invalid('body', 'body is required')
    if (bytes(input.body) > COMMENT_MAX_BYTES) return invalid('body', 'body must be at most 20 KiB')
    comment.body = input.body
    comment.editedAt = now()
    const { deleted: _deleted, ...out } = comment
    return json(out satisfies Comment)
  }

  // Attachments
  if ((match = route.match(/^(GET|DELETE) \/attachments\/([^/]+)$/))) {
    const [, method, rawId] = match
    const attachment = state.attachments.find((candidate) => candidate.id === decodeURIComponent(rawId!) && !candidate.deleted)
    const issue = attachment ? issueById(attachment.issueId) : undefined
    if (!attachment || !issue) return notFound()
    if (method === 'GET') {
      return new Response(attachment.bytes, {
        headers: {
          'Content-Type': attachment.mediaType,
          'Content-Disposition': `inline; filename="${attachment.filename.replace(/["\\]/g, '_')}"`,
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      })
    }
    if (attachment.uploader.sub !== state.caller.sub && !isAdmin()) return forbidden()
    attachment.deleted = true
    const time = now()
    record(issue, 'attachment', attachmentView(attachment), null, time)
    issue.updatedAt = time
    return noContent()
  }

  // Views
  if (route === 'GET /views') return json({ items: viewsVisible().map(viewOut) })
  if (route === 'POST /views') {
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    const problem = viewProblem(input, true)
    if (problem) return invalid(problem.path, problem.message)
    if (input.shared === true && !isAdmin()) return forbidden()
    if (state.views.length >= MAX_VIEWS) return conflict(`at most ${MAX_VIEWS} views per workspace`)
    const time = now()
    const view = {
      id: nextId(),
      name: (input.name as string).trim(),
      owner: state.caller,
      ownerSub: state.caller.sub,
      shared: input.shared === true,
      layout: (input.layout as ViewLayout | undefined) ?? 'list',
      groupBy: (input.groupBy as GroupBy | undefined) ?? 'none',
      filter: (input.filter as Filter | undefined) ?? {},
      sort: (input.sort as Sort | undefined) ?? 'updated',
      position: Math.max(-1, ...state.views.map((candidate) => candidate.position)) + 1,
      createdAt: time,
      updatedAt: time,
    }
    state.views.push(view)
    return json(viewOut(view), 201)
  }
  if ((match = route.match(/^(PATCH|DELETE) \/views\/([^/]+)$/))) {
    const [, method, rawId] = match
    const view = viewsVisible().find((candidate) => candidate.id === decodeURIComponent(rawId!))
    if (!view) return notFound()
    if (view.shared ? !isAdmin() : view.ownerSub !== state.caller.sub) return forbidden()
    if (method === 'DELETE') {
      state.views = state.views.filter((candidate) => candidate !== view)
      return noContent()
    }
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    const problem = viewProblem(input, false)
    if (problem) return invalid(problem.path, problem.message)
    if (input.shared === true && !isAdmin()) return forbidden()
    if (typeof input.name === 'string') view.name = input.name.trim()
    if (input.layout !== undefined) view.layout = input.layout as ViewLayout
    if (input.groupBy !== undefined) view.groupBy = input.groupBy as GroupBy
    if (input.filter !== undefined) view.filter = (input.filter as Filter | null) ?? {}
    if (input.sort !== undefined) view.sort = input.sort as Sort
    if (typeof input.shared === 'boolean') view.shared = input.shared
    view.updatedAt = now()
    return json(viewOut(view))
  }

  // People
  if ((match = route.match(/^GET \/people\/([^/]+)\/avatar$/))) {
    if (match[1] !== 'person-alex' || process.env.MOCK_DIRECTORY === 'absent') return notFound()
    const version = url.searchParams.get('v') ?? ''
    const etag = `"${new Bun.CryptoHasher('sha256').update(version).update(new Uint8Array([0])).update(AVATAR_PNG).digest('hex')}"`
    const headers = { 'ETag': etag, 'Cache-Control': version ? 'private, max-age=86400' : 'private, no-cache', 'X-Content-Type-Options': 'nosniff' }
    if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers })
    return new Response(AVATAR_PNG, { headers: { ...headers, 'Content-Type': 'image/png' } })
  }
  if (route === 'GET /people') {
    if (process.env.MOCK_DIRECTORY === 'absent') return json({ items: [], source: 'unavailable' })
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const items = Object.values(MOCK_PEOPLE).filter((person) => !q || person.name.toLowerCase().includes(q) || person.sub.includes(q))
    return json({ items: items.slice(0, PEOPLE_LIMIT), source: 'directory' })
  }

  return notFound()
}
