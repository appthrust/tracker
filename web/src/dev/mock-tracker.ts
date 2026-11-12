// Dev-only in-memory implementation of the tracker contract
// (`/api/tracker/v1/*`, design/API.md). Fixture shared with the server's dev
// seed (`TRACKER_DEV_SEED=1`): workspace key APT, the six default statuses,
// three people (dev-alex Alex Chen, dev-sam Sam Rivera, dev-jordan Jordan
// Lee), three labels (regression/red, ux/purple, docs/blue), three projects
// (Dashboard/blue, Platform API/purple, Builder Console/orange), 30 issues
// across every status (Alex Chen reports 10 of them, so "Reported by me" is
// not empty), then 2 epics and 4 stories (APT-31…36, In Progress) that bundle
// every seeded issue n with n % 5 != 0 under stories[n % 4], four Done work
// items (APT-37…40) and three shared views (Bugs, My issues, By epic).
// Sprints (API.md v0.1.10, relative to today in Asia/Tokyo): three closed
// one-week sprints with velocities 18/21/24 points, an active two-week sprint
// on its fourth day with a scope increase and a cancellation, and a planned
// one; 17 work items carry a size. The exact fixture (shared authority with
// the server seed) is `SPRINT_FIXTURE` below.
// Agents (API.md "Agents"): four registered agents (astra, opus-ui, claude,
// legacy-bot disabled; opus-ui registered itself with the key `ak-md8mw`,
// the others were registered by an Admin), delegations, runs (running, waiting, stalled,
// succeeded), requests, a mention and two agent-reported issues (APT-41/42),
// all relative to the moment of seeding — the shared fixture is
// `.tmp/agents-ui/fixture.md`, mirrored by `seedAgents` below. Leases are
// real: ten minutes after a reset the live runs turn stalled.
// The caller is Alex Chen as Team Admin; MOCK_ROLE=Editor (or Viewer) makes
// them a non-admin. `POST /api/tracker/v1/__mock/caller {sub, role?}` switches
// the signed-in person (role default Editor); a `sub` outside the seed needs a
// `name` and signs in someone who has reported and been assigned nothing.
// A request with `X-Mock-Agent: <handle>` acts as that agent's Access Key
// assertion instead (`X-Mock-Scopes: tracker:read,tracker:write`, the default
// being both): an unknown or disabled handle is 403 `key_subject`.
// `POST /api/tracker/v1/__mock/clock {advanceMs}` moves the mock's clock
// forward (leases expire without waiting).
// `POST /api/tracker/v1/__mock/reset` reseeds all state (body
// `{"projects":"none"}` reseeds without projects).
// MOCK_PROJECTS=none starts with no projects (a workspace from before v0.2,
// like the live install). MOCK_DIRECTORY=absent makes `GET /people` answer
// `source: unavailable`. The issue cursor is base64url(offset), opaque to the SPA.
import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  Activity,
  ActivityField,
  Actor,
  Agent,
  AgentCompletion,
  ApiError,
  Attachment,
  Burndown,
  Comment,
  EventType,
  Filter,
  GroupBy,
  InboxItem,
  Issue,
  IssueRef,
  IssueSummary,
  IssueType,
  Label,
  LabelColor,
  Link,
  Me,
  Person,
  Priority,
  Progress,
  Project,
  Report,
  RequestKind,
  RequestState,
  Role,
  Run,
  Size,
  Sort,
  Sprint,
  SprintLength,
  SprintRef,
  SprintState,
  Status,
  StatusCategory,
  Tally,
  TimelineItem,
  TrackerEvent,
  TrackerRequest,
  Unit,
  Velocity,
  VelocityEntry,
  View,
  ViewLayout,
  Workspace,
} from '../api/tracker'
import {
  ACCESS_KEY_SCOPES,
  AGENT_COMPLETIONS,
  AGENT_DESCRIPTION_MAX_BYTES,
  AGENT_HANDLE_PATTERN,
  AGENT_NAME_MAX,
  agentIdOf,
  agentSub,
  canAnswer,
  canCancelRun,
  compareActionable,
  DECISION_OPTIONS,
  deriveRunState,
  IDEMPOTENCY_KEY_MAX,
  isActionable,
  isAddressedTo,
  isLiveRun,
  isTerminalRun,
  LEASE_MS,
  LINK_TITLE_MAX,
  maySetCompleted,
  parseMentions,
  REQUEST_BODY_MAX_BYTES,
  REQUEST_OPTIONS_MAX,
  REQUEST_TITLE_MAX,
  RUN_LINKS_MAX,
  RUN_SUMMARY_MAX_BYTES,
  RUN_TEXT_MAX,
  type StoredRunState,
} from '../model/agents'
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
import {
  addDays,
  addTally,
  averagePerWeek,
  burndownPoints,
  comingMonday,
  compareSprints,
  dayInZone,
  doneIn,
  endsOnFor,
  isDay,
  overlapsAny,
  scopeIn,
  SIZE_POINTS,
  SIZES,
  SPRINT_GOAL_MAX_BYTES,
  SPRINT_LENGTHS,
  SPRINT_NAME_MAX,
  sprintDeltas,
  sprintRef,
  UNITS,
  ZERO_TALLY,
  type SprintStanding,
} from '../model/sprints'

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
  sprint: true,
  assigneeKind: true,
  agent: true,
  run: true,
  request: true,
}
const VELOCITY_LIMIT_DEFAULT = 8
const VELOCITY_LIMIT_MAX = 26
const DEFAULT_TIMEZONE = 'Asia/Tokyo'

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

/** A person as an API Actor. */
const personActor = (person: Person): Actor => ({ ...person, kind: 'person' })

export const MOCK_WORKSPACE_ID = 'pj-mock'

type StoredIssue = {
  id: string
  number: number
  title: string
  description: string
  type: IssueType
  priority: Priority
  statusId: string
  /** Agent actors are stored by `sub` and resolved at read time (name, owner and `disabled` stay current). */
  assignee: Actor | null
  reporter: Actor
  delegator: Person | null
  labelIds: string[]
  projectId: string | null
  parentId: string | null
  dueOn: string | null
  report: Report | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  deleted: boolean
  estimate: Size | null
  sprintId: string | null
}
type StoredComment = Omit<Comment, 'mentions'> & { deleted: boolean }
type StoredAgent = { id: string; handle: string; name: string; description: string; owner: Person; disabled: boolean; registeredByKey: string | null; createdAt: string; updatedAt: string; lastSeenAt: string | null }
/** `state` never holds `stalled`: it is derived from `leaseExpiresAt` on read, as on the server. */
type StoredRun = Omit<Run, 'issue' | 'agent' | 'state'> & { issueId: string; agentId: string; state: StoredRunState }
type StoredRequest = {
  id: string
  issueId: string
  kind: RequestKind
  fromSub: string
  toSub: string | null
  title: string
  body: string
  options: string[]
  runId: string | null
  state: RequestState
  answer: { option: string | null; body: string; bySub: string; at: string } | null
  createdAt: string
  /** The requester acknowledged the answer in its inbox. */
  answerAcked: boolean
}
type StoredMention = { commentId: string; issueId: string; targetSub: string; acked: boolean }
type StoredIdempotency = { body: string; status: number; response: string; at: number }
/** Who a request acts as: the signed-in person, or an agent's Access Key assertion with its scopes. */
type Caller = { actor: Actor; role: Role; agent: StoredAgent | null; scopes: readonly string[] }
type StoredAttachment = Attachment & { bytes: Uint8Array<ArrayBuffer>; deleted: boolean }
type StoredProject = { id: string; name: string; description: string; color: LabelColor; archivedAt: string | null; createdAt: string; updatedAt: string }
type Block = { blockerId: string; blockedId: string }
/** `state` is derived from `startedAt`/`closedAt`, as on the server. */
type StoredSprint = { id: string; number: number; name: string; goal: string; lengthWeeks: SprintLength; startsOn: string; endsOn: string; startedAt: string | null; closedAt: string | null; createdAt: string; updatedAt: string }
/** One `tracker_sprint_event` row: the signed deltas one issue write caused in one sprint. */
type SprintEvent = { id: string; sprintId: string; issueId: string; at: string; tally: Tally }
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
/** API.md v0.1.7 fixture, in creation order after the seed issues (same titles and order as the server seed). */
const EPIC_SEED: readonly string[] = ['Reliable bug intake', 'Faster triage']
/** Story `s` belongs to EPIC_SEED[floor(s / 2)]. */
const STORY_SEED: readonly string[] = [
  'As a reporter, I want to submit a complete bug report',
  'As a triager, I want to reproduce reported bugs',
  'As a triager, I want to prioritize incoming work',
  'As an assignee, I want to find my next task',
]
/** API.md v0.1.10 fixture: Done work items appended after the stories (closed-sprint members). */
const DONE_SEED: readonly [string, IssueType][] = [
  ['Speed up issue search', 'task'],
  ['Add bulk status change', 'feature'],
  ['Tidy up the settings layout', 'task'],
  ['Show issue counts per project', 'feature'],
]

type FixtureTime = readonly [dayOffset: number, time: string]
/**
 * The sprint fixture shared with the server seed (offsets are days from
 * today in Asia/Tokyo, times are that zone's wall clock). Every ledger row is
 * a join (+scope), done (+done) or cancel (−scope) of one issue by number at
 * its size; the rows yield velocities 18/21/24 points (committed 21/24/27),
 * an active sprint at commitment 10 points / 6 issues with a scope increase
 * (APT-10) and a cancellation (APT-30), and a planned sprint of 4 points.
 */
export const SPRINT_FIXTURE = {
  sizes: { 8: 'XS', 16: 'XS', 3: 'S', 10: 'S', 30: 'S', 2: 'M', 4: 'M', 14: 'M', 11: 'L', 17: 'L', 37: 'L', 5: 'XL', 23: 'XL', 29: 'XL', 38: 'XL', 39: 'XL', 40: 'XL' } as Record<number, Size>,
  sprints: [
    { number: 1, lengthWeeks: 1, startOffset: -24, goal: 'Bug intake basics', started: true, closed: true, members: [5, 11, 17] },
    { number: 2, lengthWeeks: 1, startOffset: -17, goal: 'Triage flow', started: true, closed: true, members: [23, 29, 37] },
    { number: 3, lengthWeeks: 1, startOffset: -10, goal: 'Board polish', started: true, closed: true, members: [38, 39, 40] },
    { number: 4, lengthWeeks: 2, startOffset: -3, goal: 'Sprint planning and burndown', started: true, closed: false, members: [2, 3, 4, 10, 15, 30, 34] },
    { number: 5, lengthWeeks: 1, startOffset: 11, goal: '', started: false, closed: false, members: [8, 14, 26], createdAt: [-1, '10:00'] as FixtureTime },
  ] as { number: number; lengthWeeks: SprintLength; startOffset: number; goal: string; started: boolean; closed: boolean; members: number[]; createdAt?: FixtureTime }[],
  rows: [
    [1, 'join', [5, 11, 17, 2], [-25, '15:00']],
    [1, 'done', [5], [-22, '16:00']],
    [1, 'done', [11], [-20, '11:00']],
    [1, 'done', [17], [-18, '17:00']],
    [2, 'join', [23, 29, 37], [-18, '15:00']],
    [2, 'join', [2], [-18, '18:00']],
    [2, 'done', [23], [-16, '16:00']],
    [2, 'done', [37], [-14, '11:00']],
    [2, 'done', [29], [-12, '17:00']],
    [3, 'join', [38, 39, 40], [-11, '15:00']],
    [3, 'join', [2], [-11, '18:00']],
    [3, 'done', [38], [-9, '16:00']],
    [3, 'done', [39], [-7, '11:00']],
    [3, 'done', [40], [-4, '10:00']],
    [4, 'join', [3, 4, 15, 30, 34], [-4, '14:00']],
    [4, 'join', [2], [-4, '18:00']],
    [4, 'join', [10], [-2, '11:00']],
    [4, 'cancel', [30], [-1, '15:00']],
    [5, 'join', [8, 14, 26], [-1, '10:00']],
  ] as [sprint: number, kind: 'join' | 'done' | 'cancel', issues: number[], at: FixtureTime][],
}

/** The instant at wall-clock `time` (HH:MM) on `day` in `timeZone`. */
function zonedInstant(day: string, time: string, timeZone: string): string {
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  const guess = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hour, minute)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(guess)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((candidate) => candidate.type === type)!.value)
  const shown = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'))
  return new Date(guess - (shown - guess)).toISOString()
}

/**
 * Mirrors the server's SeedDev: issue `i` has status i%6, type i%3 (bug,
 * feature, task), priority i%5, label i%3, reporter i%3, assignee (i+1)%3,
 * project by `seedProjectIndex(i+1)`; bugs carry a report with environment
 * i%4 and surface i%7. Then the epics and stories: In Progress, medium
 * priority, reported by Alex, unassigned, no labels, project or description;
 * seed issue n (1-based) with n % 5 != 0 gets the parent stories[n % 4]. Then
 * DONE_SEED the same way in status Done, and SPRINT_FIXTURE.
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
  const people = [MOCK_PEOPLE.alex, MOCK_PEOPLE.sam, MOCK_PEOPLE.jordan].map(personActor)
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
      delegator: null,
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
      estimate: null,
      sprintId: null,
    }
    issues.push(issue)
    activities.push({ id: ulid(T0 + (i + 1) * HOUR, seq++), issueId: issue.id, actor: issue.reporter, field: 'created', from: null, to: null, createdAt })
  })
  const inProgress = statuses.find((status) => status.name === 'In Progress')!
  const done = statuses.find((status) => status.name === 'Done')!
  const bundle = (title: string, type: IssueType, parentId: string | null, status = inProgress): StoredIssue => {
    const number = issues.length + 1
    const createdAt = at(number)
    const issue: StoredIssue = {
      id: ulid(T0 + number * HOUR, seq++),
      number,
      title,
      description: '',
      type,
      priority: 'medium',
      statusId: status.id,
      assignee: null,
      reporter: personActor(MOCK_PEOPLE.alex),
      delegator: null,
      labelIds: [],
      projectId: null,
      parentId,
      dueOn: null,
      report: null,
      createdAt,
      updatedAt: createdAt,
      completedAt: status === done ? createdAt : null,
      deleted: false,
      estimate: null,
      sprintId: null,
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
  for (const [title, type] of DONE_SEED) bundle(title, type, null, done)
  const byNumber = (number: number) => issues[number - 1]!
  for (const [number, size] of Object.entries(SPRINT_FIXTURE.sizes)) byNumber(Number(number)).estimate = size
  const today = dayInZone(Math.max(Date.now(), T0 + 100 * HOUR), DEFAULT_TIMEZONE)
  const instant = ([offset, time]: FixtureTime) => zonedInstant(addDays(today, offset), time, DEFAULT_TIMEZONE)
  const sprints: StoredSprint[] = SPRINT_FIXTURE.sprints.map((fixture) => {
    const startsOn = addDays(today, fixture.startOffset)
    const endsOn = endsOnFor(startsOn, fixture.lengthWeeks)
    const createdAt = instant(fixture.createdAt ?? [fixture.startOffset - 1, '15:00'])
    const startedAt = fixture.started ? zonedInstant(startsOn, '09:00', DEFAULT_TIMEZONE) : null
    const closedAt = fixture.closed ? zonedInstant(endsOn, '18:00', DEFAULT_TIMEZONE) : null
    const sprint: StoredSprint = { id: ulid(Date.parse(createdAt), seq++), number: fixture.number, name: `Sprint ${fixture.number}`, goal: fixture.goal, lengthWeeks: fixture.lengthWeeks, startsOn, endsOn, startedAt, closedAt, createdAt, updatedAt: closedAt ?? startedAt ?? createdAt }
    for (const number of fixture.members) byNumber(number).sprintId = sprint.id
    return sprint
  })
  const sprintEvents: SprintEvent[] = SPRINT_FIXTURE.rows.flatMap(([sprintNumber, kind, numbers, time]) =>
    numbers.map((number) => {
      const points = SIZE_POINTS[SPRINT_FIXTURE.sizes[number]!] ?? 0
      const tally: Tally =
        kind === 'join' ? { ...ZERO_TALLY, scopePoints: points, scopeIssues: 1 } : kind === 'done' ? { ...ZERO_TALLY, donePoints: points, doneIssues: 1 } : { ...ZERO_TALLY, scopePoints: -points, scopeIssues: -1 }
      const at = instant(time)
      return { id: ulid(Date.parse(at), seq++), sprintId: sprints[sprintNumber - 1]!.id, issueId: byNumber(number).id, at, tally }
    })
  )
  const views: (View & { ownerSub: string })[] = [
    { id: ulid(T0, seq++), name: 'Bugs', owner: personActor(MOCK_PEOPLE.alex), ownerSub: MOCK_PEOPLE.alex.sub, shared: true, layout: 'list', groupBy: 'none', filter: { type: ['bug'] }, sort: 'updated', position: 0, createdAt: at(0), updatedAt: at(0) },
    { id: ulid(T0, seq++), name: 'My issues', owner: personActor(MOCK_PEOPLE.alex), ownerSub: MOCK_PEOPLE.alex.sub, shared: true, layout: 'list', groupBy: 'none', filter: { assignee: ['me'] }, sort: 'updated', position: 1, createdAt: at(0), updatedAt: at(0) },
    { id: ulid(T0, seq++), name: 'By epic', owner: personActor(MOCK_PEOPLE.alex), ownerSub: MOCK_PEOPLE.alex.sub, shared: true, layout: 'board', groupBy: 'epic', filter: {}, sort: 'updated', position: 2, createdAt: at(0), updatedAt: at(0) },
  ]
  const role = process.env.MOCK_ROLE === 'Editor' || process.env.MOCK_ROLE === 'Viewer' ? (process.env.MOCK_ROLE as Role) : 'Admin'
  return {
    workspace: { id: MOCK_WORKSPACE_ID, key: 'APT', name: MOCK_WORKSPACE_ID, sprintLengthWeeks: 1 as SprintLength, timezone: DEFAULT_TIMEZONE, agentCompletion: 'review' as AgentCompletion, createdAt: at(0), updatedAt: at(0) },
    statuses,
    labels,
    projects,
    issues,
    blocks: [] as Block[],
    activities,
    comments: [] as StoredComment[],
    attachments: [] as StoredAttachment[],
    views,
    sprints,
    sprintEvents,
    caller: MOCK_PEOPLE.alex as Person,
    role,
    clock: T0 + 100 * HOUR,
    /** Added to the wall clock (`POST /__mock/clock`). */
    offset: 0,
    seq: seq + 1000,
    agents: [] as StoredAgent[],
    runs: [] as StoredRun[],
    requests: [] as StoredRequest[],
    mentions: [] as StoredMention[],
    events: [] as TrackerEvent[],
    eventSeq: 0,
    idempotency: new Map<string, StoredIdempotency>(),
  }
}

type MockState = ReturnType<typeof seedTracker>

/** One agent of the fixture (`.tmp/agents-ui/fixture.md`, "Agents"); times are offsets from the moment of seeding. `registeredByKey`: the key it registered itself with (absent: an Admin registered it). */
type AgentFixture = { handle: string; name: string; owner: Person; disabled: boolean; description: string; created: number; updated: number; seen: number; registeredByKey?: string }
const MINUTE = 60_000
const DAY = 24 * HOUR
export const AGENT_FIXTURE = {
  agents: [
    { handle: 'astra', name: 'Astra', owner: MOCK_PEOPLE.sam, disabled: false, description: 'Backend implementer. Go handlers, store queries, migrations and their tests. Delegate issues with a clear acceptance check.', created: -14 * DAY, updated: -14 * DAY, seen: -2 * MINUTE },
    { handle: 'opus-ui', name: 'Opus UI', owner: MOCK_PEOPLE.alex, disabled: false, description: 'UI implementer. React screens, copy and accessibility in the SPA. Delegate issues that include the expected screen or a screenshot.', created: -7 * DAY, updated: -7 * DAY, seen: -1 * MINUTE, registeredByKey: 'ak-md8mw' },
    { handle: 'claude', name: 'Claude', owner: MOCK_PEOPLE.jordan, disabled: false, description: 'Planner and triage. Reads new reports, finds duplicates, proposes priority and sprint. Does not change code.', created: -14 * DAY, updated: -14 * DAY, seen: -2 * HOUR },
    { handle: 'legacy-bot', name: 'Legacy bot', owner: MOCK_PEOPLE.alex, disabled: true, description: 'Old nightly triage script. Replaced by claude.', created: -60 * DAY, updated: -30 * DAY, seen: -32 * DAY },
  ] as AgentFixture[],
  /** [issue number, agent handle, delegator, assigned at] */
  delegations: [
    [15, 'astra', MOCK_PEOPLE.alex, -40 * MINUTE],
    [27, 'opus-ui', MOCK_PEOPLE.alex, -45 * MINUTE],
    [9, 'astra', MOCK_PEOPLE.sam, -4 * HOUR],
    [16, 'astra', MOCK_PEOPLE.alex, -3 * HOUR],
    [4, 'astra', MOCK_PEOPLE.sam, -27 * HOUR],
    [21, 'claude', MOCK_PEOPLE.alex, -4 * HOUR],
    [13, 'opus-ui', MOCK_PEOPLE.alex, -1 * DAY],
    [26, 'opus-ui', MOCK_PEOPLE.jordan, -1 * DAY],
    [19, 'astra', MOCK_PEOPLE.sam, -2 * DAY],
  ] as [number, string, Person, number][],
  reviewSummary16: [
    'The CLI refreshed its login only after a request failed with 401, so the first command after one hour always failed.',
    '',
    '- Refresh the token when less than 5 minutes of its lifetime remain.',
    '- Retry once on 401 after a refresh.',
    '- Added `TestLoginRefreshBeforeExpiry`.',
  ].join('\n'),
  reviewSummary4: 'Status reads now bypass the list cache after a status change. Added a regression test for the list endpoint.',
}

/**
 * The agents fixture (`.tmp/agents-ui/fixture.md`), applied after the rest of
 * the seed: agents, delegations, APT-41/42 reported by agents, runs, requests,
 * a comment with a mention. `at(offset)` is relative to the seeding instant.
 */
function seedAgents(seeded: MockState) {
  const base = Math.max(Date.now(), seeded.clock)
  const at = (offset: number) => new Date(base + offset).toISOString()
  const id = (offset: number) => ulid(base + offset, seeded.seq++)
  const issueNo = (number: number) => seeded.issues.find((issue) => issue.number === number)!
  const agents = AGENT_FIXTURE.agents.map((fixture): StoredAgent => ({
    id: id(fixture.created),
    handle: fixture.handle,
    name: fixture.name,
    description: fixture.description,
    owner: fixture.owner,
    disabled: fixture.disabled,
    registeredByKey: fixture.registeredByKey ?? null,
    createdAt: at(fixture.created),
    updatedAt: at(fixture.updated),
    lastSeenAt: at(fixture.seen),
  }))
  seeded.agents = agents
  const agent = (handle: string) => agents.find((candidate) => candidate.handle === handle)!
  const stub = (handle: string): Actor => ({ sub: agentSub(agent(handle).id), name: agent(handle).name, kind: 'agent' })
  for (const [number, handle, delegator, offset] of AGENT_FIXTURE.delegations) {
    const issue = issueNo(number)
    const time = at(offset)
    const actor = personActor(delegator)
    seeded.activities.push({ id: id(offset), issueId: issue.id, actor, field: 'assignee', from: issue.assignee, to: stub(handle), createdAt: time })
    seeded.activities.push({ id: id(offset), issueId: issue.id, actor, field: 'delegator', from: null, to: delegator, createdAt: time })
    Object.assign(issue, { assignee: stub(handle), delegator, updatedAt: time })
  }
  // APT-41 and APT-42: reported by agents, appended after the existing issues.
  const backlog = seeded.statuses.find((status) => status.name === 'Backlog')!
  const todo = seeded.statuses.find((status) => status.name === 'Todo')!
  const platformApi = seeded.projects.find((project) => project.name === 'Platform API')?.id ?? null
  const reported = (title: string, type: IssueType, priority: Priority, statusId: string, reporter: string, offset: number, description: string, extra: Partial<StoredIssue>) => {
    const time = at(offset)
    const issue: StoredIssue = {
      id: id(offset),
      number: seeded.issues.length + 1,
      title,
      description,
      type,
      priority,
      statusId,
      assignee: null,
      reporter: stub(reporter),
      delegator: null,
      labelIds: [],
      projectId: platformApi,
      parentId: null,
      dueOn: null,
      report: null,
      createdAt: time,
      updatedAt: time,
      completedAt: null,
      deleted: false,
      estimate: null,
      sprintId: null,
      ...extra,
    }
    seeded.issues.push(issue)
    seeded.activities.push({ id: id(offset), issueId: issue.id, actor: issue.reporter, field: 'created', from: null, to: null, createdAt: time })
    return issue
  }
  const apt41 = reported('Three reports describe the same stale status', 'task', 'high', backlog.id, 'claude', -5 * HOUR, 'APT-4, APT-22 and APT-28 all show a status that lags behind the real one by one refresh. Proposal: keep APT-4 and close the other two as duplicates.', {})
  reported('Flaky test: lease renewal in store/runs_test', 'bug', 'medium', todo.id, 'astra', -3 * HOUR, 'TestHeartbeatRenewsLease fails about 1 in 30 runs on CI.', {
    assignee: stub('astra'),
    delegator: agent('astra').owner,
    report: { environment: 'local', surface: 'platform-api', version: '0.1.13', steps: 'go test -count=30 ./cmd/server/internal/store -run TestHeartbeatRenewsLease', expected: 'All runs pass.', actual: 'One run fails with lease_expired.' },
  })
  const run = (number: number, handle: string, state: StoredRunState, session: string, note: string, started: number, heartbeat: number, finished: number | null, summary = '', links: Link[] = []): StoredRun => {
    const stored: StoredRun = {
      id: id(started),
      issueId: issueNo(number).id,
      agentId: agent(handle).id,
      state,
      reason: null,
      session,
      note,
      summary,
      links,
      startedAt: at(started),
      heartbeatAt: at(heartbeat),
      leaseExpiresAt: at(heartbeat + LEASE_MS),
      finishedAt: finished === null ? null : at(finished),
    }
    seeded.runs.push(stored)
    return stored
  }
  const run15 = run(15, 'astra', 'running', 'astra · lane-2', 'running go test ./cmd/server/... after removing 14 unused fixtures', -35 * MINUTE, -2 * MINUTE, null)
  const run27 = run(27, 'opus-ui', 'waiting', 'opus-ui · a11y pass', 'waiting for a decision on the close-button label', -40 * MINUTE, -1 * MINUTE, null)
  run(9, 'astra', 'running', 'astra · lane-1', 'comparing the Gateway page with the current kubeconfig flow', -3 * HOUR, -52 * MINUTE, null)
  const run16 = run(16, 'astra', 'succeeded', 'astra · lane-2', 'opening the pull request', -2 * HOUR, -25 * MINUTE, -25 * MINUTE, AGENT_FIXTURE.reviewSummary16, [
    { kind: 'pr', url: 'https://github.com/appthrust/tracker/pull/142', title: 'Refresh the CLI login before the token expires' },
  ])
  const run4 = run(4, 'astra', 'succeeded', 'astra · lane-1', 'opening the pull request', -26 * HOUR, -24 * HOUR, -24 * HOUR, AGENT_FIXTURE.reviewSummary4, [
    { kind: 'pr', url: 'https://github.com/appthrust/tracker/pull/138', title: 'Invalidate the status cache on change' },
  ])
  const subOf = (handle: string) => agentSub(agent(handle).id)
  const request = (number: number, kind: RequestKind, fromSub: string, toSub: string | null, runId: string | null, title: string, created: number, extra: Partial<StoredRequest> = {}): StoredRequest => {
    const stored: StoredRequest = {
      id: id(created),
      issueId: issueNo(number).id,
      kind,
      fromSub,
      toSub,
      title,
      body: '',
      options: kind === 'question' ? [] : [...DECISION_OPTIONS],
      runId,
      state: 'open',
      answer: null,
      createdAt: at(created),
      answerAcked: false,
      ...extra,
    }
    seeded.requests.push(stored)
    return stored
  }
  request(27, 'question', subOf('opus-ui'), MOCK_PEOPLE.alex.sub, run27.id, "Which label should the panel's close button use?", -8 * MINUTE, {
    body: 'The panel\'s close button has no visible text. "Close" matches the rest of the app; "Dismiss" is what the screen reader announces today.',
    options: ['Close', 'Dismiss', 'Keep both: visible "Close", spoken "Dismiss"'],
  })
  request(15, 'question', subOf('astra'), MOCK_PEOPLE.alex.sub, run15.id, 'Delete the fixtures under testdata/legacy too?', -28 * MINUTE, {
    options: ['Yes, delete them', 'No, keep them'],
    state: 'answered',
    answer: { option: 'Yes, delete them', body: 'They are unused since 0.1.7.', bySub: MOCK_PEOPLE.alex.sub, at: at(-20 * MINUTE) },
    answerAcked: true,
  })
  request(16, 'review', subOf('astra'), MOCK_PEOPLE.alex.sub, run16.id, `Review: ${issueNo(16).title}`, -25 * MINUTE, { body: run16.summary })
  request(4, 'review', subOf('astra'), MOCK_PEOPLE.sam.sub, run4.id, `Review: ${issueNo(4).title}`, -24 * HOUR, {
    body: run4.summary,
    state: 'answered',
    answer: { option: 'reject', body: 'Still stale right after a status change: the 304 path keeps the old ETag. Please add a test for it.', bySub: MOCK_PEOPLE.sam.sub, at: at(-20 * HOUR) },
  })
  request(1, 'approval', subOf('claude'), null, null, 'Add APT-1 to the current sprint?', -90 * MINUTE, { body: 'Two people lost their filters on appthrust.dev this week. It is urgent but sits in the backlog without a sprint.' })
  request(21, 'question', MOCK_PEOPLE.alex.sub, subOf('claude'), null, 'Which open bugs look like duplicates of APT-22?', -3 * HOUR, {
    state: 'answered',
    answer: { option: null, body: 'APT-4 and APT-28 describe the same stale-cache symptom; I filed APT-41 to merge them.', bySub: subOf('claude'), at: at(-2 * HOUR) },
  })
  const comment = (number: number, author: Actor, offset: number, text: string) => {
    const stored: StoredComment = { id: id(offset), issueId: issueNo(number).id, author, body: text, createdAt: at(offset), editedAt: null, deleted: false }
    seeded.comments.push(stored)
    return stored
  }
  const mention = comment(22, personActor(MOCK_PEOPLE.sam), -1 * HOUR, '@astra could you check whether the cursor encoding changed with APT-15? The skipped rows start after page 2.')
  seeded.mentions.push({ commentId: mention.id, issueId: mention.issueId, targetSub: subOf('astra'), acked: false })
  comment(apt41.number, stub('claude'), -5 * HOUR, 'Filed from triage. Evidence: the three reports name the same endpoint and the same one-refresh lag.')
  return seeded
}

let state = seedAgents(seedTracker())

/** The mock's wall clock: real time plus the `__mock/clock` offset. */
const wallClock = () => Date.now() + state.offset

/** Strictly increasing wall-clock time, so two writes in one millisecond still order. */
function now(): string {
  state.clock = Math.max(wallClock(), state.clock + 1)
  return new Date(state.clock).toISOString()
}
const nextId = () => ulid(state.clock, state.seq++)

const callerContext = new AsyncLocalStorage<Caller>()
/** The caller of the request being handled (`trackerRoutes` runs each request inside its own context, so concurrent requests never mix). */
const who = (): Caller => callerContext.getStore() ?? { actor: personActor(state.caller), role: state.role, agent: null, scopes: ACCESS_KEY_SCOPES }

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

/** Signed-in Admins only: an agent's key acts with role Viewer (API.md "Access Keys"). */
const isAdmin = () => who().agent === null && who().role === 'Admin'
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

/** Epics and stories: over all live level-0 descendants, `total` excludes canceled ones, `completed` counts completed ones; `points` sums their sizes the same way. */
function progressOf(issue: StoredIssue): Progress | null {
  if (levelOf(issue.type) === 0) return null
  const progress: Progress = { total: 0, completed: 0, points: { total: 0, completed: 0 } }
  const seen = new Set<string>([issue.id])
  for (let frontier = [issue.id]; frontier.length > 0; ) {
    const children = live().filter((candidate) => candidate.parentId !== null && frontier.includes(candidate.parentId) && !seen.has(candidate.id))
    for (const child of children) {
      seen.add(child.id)
      if (levelOf(child.type) !== 0 || categoryOf(child.statusId) === 'canceled') continue
      const points = child.estimate ? SIZE_POINTS[child.estimate] : 0
      progress.total++
      progress.points.total += points
      if (categoryOf(child.statusId) === 'completed') {
        progress.completed++
        progress.points.completed += points
      }
    }
    frontier = children.map((child) => child.id)
  }
  return progress
}

const categoryOf = (statusId: string) => state.statuses.find((status) => status.id === statusId)?.category

// --- sprints --------------------------------------------------------------------

function sprintState(sprint: StoredSprint): SprintState {
  return sprint.closedAt ? 'closed' : sprint.startedAt ? 'active' : 'planned'
}

const sprintById = (id: string | null) => (id ? state.sprints.find((sprint) => sprint.id === id) : undefined)
const activeSprint = () => state.sprints.find((sprint) => sprintState(sprint) === 'active')
const openSprints = () => state.sprints.filter((sprint) => sprintState(sprint) !== 'closed')
/** Today in the workspace timezone (reads the clock without advancing it). */
const today = () => dayInZone(Math.max(Date.now(), state.clock), state.workspace.timezone)

function refOfSprint(sprint: StoredSprint): SprintRef {
  return sprintRef({ ...sprint, state: sprintState(sprint) })
}

/** The sum of the sprint's ledger rows, optionally only up to `until` and only for issues `keep` accepts. */
function ledgerSum(sprintId: string, until?: string, keep: (issueId: string) => boolean = () => true): Tally {
  return state.sprintEvents.filter((event) => event.sprintId === sprintId && (until === undefined || event.at <= until) && keep(event.issueId)).reduce((sum, event) => addTally(sum, event.tally), ZERO_TALLY)
}

function sprintView(sprint: StoredSprint): Sprint {
  return { ...sprint, state: sprintState(sprint), current: ledgerSum(sprint.id), commitment: sprint.startedAt ? ledgerSum(sprint.id, sprint.startedAt) : null }
}

function standingOf(issue: Pick<StoredIssue, 'sprintId' | 'estimate' | 'statusId' | 'deleted'>): SprintStanding {
  return { sprintId: issue.sprintId, size: issue.estimate, category: categoryOf(issue.statusId), deleted: issue.deleted }
}

/** The ledger rule: one row per sprint the write changed, closed sprints excepted (no rows after `closedAt`). */
function writeLedger(issueId: string, before: SprintStanding, after: SprintStanding, at: string) {
  for (const [sprintId, tally] of sprintDeltas(before, after)) {
    const sprint = sprintById(sprintId)
    if (sprint && sprintState(sprint) !== 'closed') state.sprintEvents.push({ id: nextId(), sprintId, issueId, at, tally })
  }
}

/** Live strict ancestors of an issue whose parent is `parentId`. */
function ancestorsFrom(parentId: string | null): StoredIssue[] {
  const out: StoredIssue[] = []
  for (let cursor = issueById(parentId); cursor && out.length < ANCESTOR_HOPS; cursor = issueById(cursor.parentId)) out.push(cursor)
  return out
}

function descendantsOf(issueId: string): StoredIssue[] {
  const out: StoredIssue[] = []
  for (let frontier = [issueId]; frontier.length > 0; ) {
    const children = live().filter((candidate) => candidate.parentId !== null && frontier.includes(candidate.parentId))
    out.push(...children)
    frontier = children.map((child) => child.id)
  }
  return out
}

/** Ancestors (through `parentId`) and descendants of the issue that are members of `sprintId` (lineage-exclusive). */
function lineageMembers(issueId: string | null, parentId: string | null, sprintId: string): number {
  const relatives = [...ancestorsFrom(parentId), ...(issueId ? descendantsOf(issueId) : [])]
  return relatives.filter((relative) => relative.id !== issueId && relative.sprintId === sprintId).length
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
    assignee: issue.assignee ? actorView(issue.assignee) : null,
    reporter: actorView(issue.reporter),
    // People on the wire carry `kind`, as the server writes every Person-valued field (delegator, owner).
    delegator: issue.delegator ? personActor(issue.delegator) : null,
    activeRun: activeRunOf(issue.id) ? runView(activeRunOf(issue.id)!) : null,
    openRequestCount: state.requests.filter((request) => request.issueId === issue.id && request.state === 'open').length,
    labelIds: [...issue.labelIds],
    projectId: issue.projectId,
    parent: parent ? ref(parent) : null,
    epic: epic ? ref(epic) : null,
    story: story ? ref(story) : null,
    progress: progressOf(issue),
    estimate: issue.estimate,
    sprint: issue.sprintId && sprintById(issue.sprintId) ? refOfSprint(sprintById(issue.sprintId)!) : null,
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

function record(issue: StoredIssue, field: ActivityField, from: unknown, to: unknown, createdAt: string, actor: Actor = who().actor) {
  state.activities.push({ id: nextId(), issueId: issue.id, actor, field, from, to, createdAt })
}

// --- agents (API.md "Agents") --------------------------------------------------------

const agentById = (id: string | null) => (id ? state.agents.find((agent) => agent.id === id) : undefined)
const agentBySub = (sub: string) => agentById(agentIdOf(sub))

function agentActor(agent: StoredAgent): Actor {
  return { sub: agentSub(agent.id), name: agent.name, kind: 'agent', agent: { id: agent.id, handle: agent.handle, owner: personActor(agent.owner), disabled: agent.disabled } }
}

/** A stored actor as readers see it now: agents resolve to their current name, owner and state; people keep their stored name. */
function actorView(actor: Actor): Actor {
  const agent = agentBySub(actor.sub)
  if (agent) return agentActor(agent)
  const { agent: _agent, ...person } = actor
  return { ...person, kind: 'person' }
}

/** The Actor for a subject: an agent, else a person (seeded name or the subject itself). */
function actorFor(sub: string): Actor {
  const agent = agentBySub(sub)
  return agent ? agentActor(agent) : personActor(personFor(sub))
}

function agentView(agent: StoredAgent): Agent {
  const runs = state.runs.filter((run) => run.agentId === agent.id)
  return {
    ...agent,
    owner: personActor(agent.owner),
    activeRuns: runs.filter((run) => isLiveRun({ state: derived(run) })).length,
    openRequests: state.requests.filter((request) => request.fromSub === agentSub(agent.id) && request.state === 'open').length,
  }
}

/** The run's state as readers see it (`stalled` once the lease has passed). */
const derived = (run: StoredRun) => deriveRunState(run.state, run.leaseExpiresAt, wallClock())
const isStalledRun = (run: StoredRun) => derived(run) === 'stalled'
/** The issue's non-terminal run (live or stalled), if any. */
const activeRunOf = (issueId: string) => state.runs.find((run) => run.issueId === issueId && !isTerminalRun(run.state))

function runView(run: StoredRun): Run {
  const { issueId, agentId, ...rest } = run
  const issue = state.issues.find((candidate) => candidate.id === issueId)!
  return { ...rest, issue: ref(issue), agent: agentActor(agentById(agentId)!), state: derived(run), links: run.links.map((link) => ({ ...link })) }
}

function requestView(request: StoredRequest): TrackerRequest {
  const issue = state.issues.find((candidate) => candidate.id === request.issueId)!
  return {
    id: request.id,
    issue: ref(issue),
    kind: request.kind,
    from: actorFor(request.fromSub),
    to: request.toSub === null ? null : actorFor(request.toSub),
    title: request.title,
    body: request.body,
    options: [...request.options],
    runId: request.runId,
    state: request.state,
    answer: request.answer ? { option: request.answer.option, body: request.answer.body, by: actorFor(request.answer.bySub), at: request.answer.at } : null,
    createdAt: request.createdAt,
  }
}

function commentView({ deleted: _deleted, ...comment }: StoredComment): Comment {
  return { ...comment, author: actorView(comment.author), mentions: state.mentions.filter((mention) => mention.commentId === comment.id).map((mention) => actorFor(mention.targetSub)) }
}

/** Appends one Event in the transaction of the write it describes (`seq` from the workspace counter). */
function emit(type: EventType, issue: StoredIssue | null, data: unknown, at: string, actor: Actor = who().actor) {
  state.eventSeq += 1
  state.events.push({ seq: state.eventSeq, at, issue: issue ? ref(issue) : null, actor: actorView(actor), type, data })
}

/** Withdraws the run's open requests (whatever ends a run without success, and a successful finish for its questions). */
function withdrawRunRequests(run: StoredRun, time: string, kinds: readonly RequestKind[] = ['question', 'approval', 'review']) {
  const issue = issueById(run.issueId) ?? state.issues.find((candidate) => candidate.id === run.issueId)!
  for (const request of state.requests.filter((candidate) => candidate.runId === run.id && candidate.state === 'open' && kinds.includes(candidate.kind))) {
    request.state = 'withdrawn'
    emit('request.withdrawn', issue, request.id, time)
  }
}

/** Ends a non-terminal run without success (`canceled` or `failed`) and withdraws its open requests. */
function endRun(run: StoredRun, state_: 'canceled' | 'failed', reason: string, time: string) {
  const issue = state.issues.find((candidate) => candidate.id === run.issueId)!
  Object.assign(run, { state: state_, reason, finishedAt: time })
  withdrawRunRequests(run, time)
  emit(state_ === 'canceled' ? 'run.canceled' : 'run.finished', issue, run.id, time)
}

/** After a request on the run closes: a waiting run with no open request left is running again. */
function resumeIfClear(runId: string | null) {
  const run = state.runs.find((candidate) => candidate.id === runId)
  if (run?.state === 'waiting' && !state.requests.some((request) => request.runId === run.id && request.state === 'open')) run.state = 'running'
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

function estimateProblem(value: unknown, type: IssueType): Problem | undefined {
  if (value === null || value === undefined) return undefined
  if (!SIZES.includes(value as Size)) return { path: 'estimate', message: `estimate must be one of ${SIZES.join(', ')} or null` }
  if (type === 'epic') return { path: 'estimate', message: 'an epic takes no estimate' }
  return undefined
}

/** Why an issue (`issueId` null while creating) of `type` under `parentId` cannot join `value` (`domain.ValidateMembership`). */
function sprintJoinProblem(value: unknown, type: IssueType, issueId: string | null, parentId: string | null): Problem | undefined {
  if (typeof value !== 'string') return { path: 'sprintId', message: 'sprintId must be a string or null' }
  const sprint = sprintById(value)
  if (!sprint) return { path: 'sprintId', message: 'unknown sprint' }
  if (type === 'epic') return { path: 'sprintId', message: 'an epic cannot join a sprint' }
  if (sprintState(sprint) === 'closed') return { path: 'sprintId', message: 'sprint is closed' }
  if (lineageMembers(issueId, parentId, value) > 0) return { path: 'sprintId', message: 'an ancestor or descendant is already in this sprint' }
  return undefined
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
  const problem =
    enumProblem('category', CATEGORIES) ??
    enumProblem('type', ISSUE_TYPES) ??
    enumProblem('priority', PRIORITIES) ??
    enumProblem('surface', SURFACES) ??
    enumProblem('assigneeKind', ['person', 'agent']) ??
    enumProblem('run', ['active', 'stalled', 'none']) ??
    enumProblem('request', ['open', 'mine'])
  if (problem) return problem
  if ((filter.agent as string[] | undefined)?.some((value) => !ULID_PATTERN.test(value))) return { path: 'filter.agent', message: 'agent must list agent ids' }
  const reporter = filter.reporter as string[] | undefined
  if (reporter && (reporter.length > REPORTER_FILTER_MAX || reporter.some((value) => value.length === 0 || value.length > 4096)))
    return { path: 'filter.reporter', message: `reporter must list at most ${REPORTER_FILTER_MAX} subjects of 1 to 4096 characters` }
  if (typeof filter.createdAfter === 'string' && Number.isNaN(Date.parse(filter.createdAfter))) return { path: 'filter.createdAfter', message: 'createdAfter must be RFC 3339' }
  for (const key of ['epic', 'story'] as const) {
    if ((filter[key] as string[] | undefined)?.some((value) => value !== 'none' && !ULID_PATTERN.test(value))) return { path: `filter.${key}`, message: `${key} must list issue ids or none` }
  }
  if ((filter.sprint as string[] | undefined)?.some((value) => value !== 'none' && value !== 'active' && !ULID_PATTERN.test(value))) return { path: 'filter.sprint', message: 'sprint must list sprint ids, active or none' }
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
    .filter((issue) =>
      matchesFilter(issue, filter, {
        me: who().actor.sub,
        statuses: state.statuses,
        description: (candidate) => descriptions.get(candidate.id) ?? '',
        activeSprintId: activeSprint()?.id ?? null,
        raisedOpenRequest: (candidate) => state.requests.some((stored) => stored.issueId === candidate.id && stored.state === 'open' && stored.fromSub === who().actor.sub),
      })
    )
    .sort(compareIssues(sort))
  const page = matching.slice(offset, offset + limit)
  const next = offset + limit < matching.length ? Buffer.from(String(offset + limit), 'utf8').toString('base64url') : null
  return json({ items: page, nextCursor: next })
}

const personOf = ({ kind: _kind, agent: _agent, ...person }: Actor): Person => person

/**
 * `assigneeSub` on an issue write: a person's subject, or `agent:<id>` of an
 * active agent (unknown or disabled → 400). An agent assigns only itself, on
 * issues it reported (403). Assigning an agent makes the delegator the person
 * who assigned, or the assigning agent's owner.
 */
function resolveAssignee(sub: string, reporterSub: string): { assignee: Actor; delegator: Person | null } | Response {
  const caller = who()
  const id = agentIdOf(sub)
  if (id === null) return { assignee: personActor(personFor(sub)), delegator: null }
  const agent = agentById(id)
  if (!agent) return invalid('assigneeSub', 'unknown agent')
  if (agent.disabled) return invalid('assigneeSub', 'the agent is disabled')
  if (caller.agent && (caller.agent.id !== agent.id || reporterSub !== caller.actor.sub)) return forbidden()
  return { assignee: { sub, name: agent.name, kind: 'agent' }, delegator: caller.agent ? caller.agent.owner : personOf(caller.actor) }
}

/** An agent setting a completed status under the `review` policy (403). */
const completionRefused = (statusId: string) => who().agent !== null && categoryOf(statusId) === 'completed' && !maySetCompleted('agent', state.workspace.agentCompletion)

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
  if (completionRefused(statusId)) return forbidden()
  const assigned = typeof input.assigneeSub === 'string' ? resolveAssignee(input.assigneeSub, who().actor.sub) : { assignee: null, delegator: null }
  if (assigned instanceof Response) return assigned
  if (input.labelIds !== undefined && (!isStringArray(input.labelIds) || input.labelIds.some((id) => !state.labels.some((label) => label.id === id)))) return invalid('labelIds', 'unknown label')
  if (input.parentId !== undefined && input.parentId !== null && (typeof input.parentId !== 'string' || !issueById(input.parentId))) return invalid('parentId', 'unknown parent')
  const parent = issueById((input.parentId as string | null | undefined) ?? null)
  if (parent && !canParent(type, parent.type)) return invalid('parentId', hierarchyMessage(type))
  if (input.dueOn !== undefined && input.dueOn !== null && (typeof input.dueOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn))) return invalid('dueOn', 'dueOn must be YYYY-MM-DD')
  if (input.projectId !== undefined) {
    const problem = projectRefProblem(input.projectId, null)
    if (problem) return invalid(problem.path, problem.message)
  }
  const estimate = estimateProblem(input.estimate, type)
  if (estimate) return invalid(estimate.path, estimate.message)
  if (input.sprintId !== undefined && input.sprintId !== null) {
    const problem = sprintJoinProblem(input.sprintId, type, null, parent?.id ?? null)
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
    assignee: assigned.assignee,
    reporter: who().actor,
    delegator: assigned.delegator,
    labelIds: [...new Set((input.labelIds as string[] | undefined) ?? [])],
    projectId: typeof input.projectId === 'string' ? input.projectId : null,
    parentId: (input.parentId as string | undefined) ?? null,
    dueOn: (input.dueOn as string | undefined) ?? null,
    report: type === 'bug' ? cleanReport(input.report as Record<string, unknown>) : null,
    createdAt: time,
    updatedAt: time,
    completedAt: closedStatus(statusId) ? time : null,
    deleted: false,
    estimate: (input.estimate as Size | null | undefined) ?? null,
    sprintId: (input.sprintId as string | null | undefined) ?? null,
  }
  state.issues.push(issue)
  record(issue, 'created', null, null, time)
  emit('issue.created', issue, issue.id, time)
  writeLedger(issue.id, { sprintId: null, size: null, category: undefined, deleted: false }, standingOf(issue), time)
  return json(full(issue), 201)
}

async function updateIssue(issue: StoredIssue, request: Request): Promise<Response> {
  const input = await body(request)
  if (!input) return invalid('', 'A JSON object is required')
  const known = ['title', 'description', 'type', 'priority', 'statusId', 'assigneeSub', 'labelIds', 'parentId', 'blocks', 'dueOn', 'report', 'projectId', 'estimate', 'sprintId', 'expectedUpdatedAt']
  const unknownKey = Object.keys(input).find((key) => !known.includes(key))
  if (unknownKey) return invalid(unknownKey, `unknown field ${unknownKey}`)
  // An agent edits an issue's fields only as its assignee or reporter.
  const caller = who()
  if (caller.agent && issue.assignee?.sub !== caller.actor.sub && issue.reporter.sub !== caller.actor.sub) return forbidden()
  if ('expectedUpdatedAt' in input) {
    if (typeof input.expectedUpdatedAt !== 'string') return invalid('expectedUpdatedAt', 'expectedUpdatedAt must be an RFC 3339 timestamp')
    if (input.expectedUpdatedAt !== issue.updatedAt) return conflict('the issue changed since it was read; reload it and apply the change again')
  }
  if ('title' in input) {
    const problem = titleProblem(input.title)
    if (problem) return invalid(problem.path, problem.message)
  }
  if ('description' in input && (typeof input.description !== 'string' || bytes(input.description) > DESCRIPTION_MAX_BYTES)) return invalid('description', 'description must be at most 50 KiB')
  if ('type' in input && !ISSUE_TYPES.includes(input.type as IssueType)) return invalid('type', 'unknown type')
  if ('priority' in input && !PRIORITIES.includes(input.priority as Priority)) return invalid('priority', 'unknown priority')
  if ('statusId' in input && !state.statuses.some((status) => status.id === input.statusId)) return invalid('statusId', 'unknown status')
  if ('statusId' in input && input.statusId !== issue.statusId && completionRefused(input.statusId as string)) return forbidden()
  if ('assigneeSub' in input && input.assigneeSub !== null && typeof input.assigneeSub !== 'string') return invalid('assigneeSub', 'assigneeSub must be a string or null')
  const assigneeChanged = 'assigneeSub' in input && (input.assigneeSub ?? null) !== (issue.assignee?.sub ?? null)
  const assigned = !assigneeChanged ? undefined : typeof input.assigneeSub === 'string' ? resolveAssignee(input.assigneeSub, issue.reporter.sub) : { assignee: null, delegator: null }
  if (assigned instanceof Response) return assigned
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
  // Estimate and sprint (API.md v0.1.10): an epic takes neither; a closed sprint's members are frozen; a type or parent change re-checks membership.
  const nextEstimate = 'estimate' in input ? ((input.estimate as Size | null) ?? null) : issue.estimate
  const estimate = 'estimate' in input ? estimateProblem(input.estimate, nextType) : nextType === 'epic' && nextEstimate ? { path: 'estimate', message: 'an epic takes no estimate' } : undefined
  if (estimate) return invalid(estimate.path, estimate.message)
  const nextSprintId = 'sprintId' in input ? ((input.sprintId as string | null) ?? null) : issue.sprintId
  const sprintChanged = nextSprintId !== issue.sprintId
  const currentSprint = sprintById(issue.sprintId)
  if (sprintChanged && currentSprint && sprintState(currentSprint) === 'closed') return invalid('sprintId', 'membership is frozen once the sprint is closed')
  const nextParentId = nextParent?.id ?? null
  if (nextSprintId && (sprintChanged || parentChanged || nextType !== issue.type)) {
    const problem = sprintChanged ? sprintJoinProblem(nextSprintId, nextType, issue.id, nextParentId) : nextType === 'epic' ? { path: 'sprintId', message: 'an epic cannot join a sprint' } : lineageMembers(issue.id, nextParentId, nextSprintId) > 0 ? { path: 'sprintId', message: 'an ancestor or descendant is already in this sprint' } : undefined
    if (problem) return invalid(problem.path, problem.message)
  }
  if (parentChanged) {
    // The subtree's members against the new ancestors, open sprints only.
    const ancestors = ancestorsFrom(nextParentId)
    const clash = descendantsOf(issue.id).find((child) => child.sprintId && sprintState(sprintById(child.sprintId)!) !== 'closed' && ancestors.some((ancestor) => ancestor.sprintId === child.sprintId))
    if (clash) return invalid('sprintId', `${identifier(clash)}: an ancestor or descendant is already in this sprint`)
  }

  const time = now()
  const before = standingOf(issue)
  const fields: ActivityField[] = []
  const change = (field: ActivityField, from: unknown, to: unknown) => {
    record(issue, field, from, to, time)
    fields.push(field)
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
  if (assigned) {
    // Away from an agent: its non-terminal run (stalled included) is canceled in the same write.
    const run = issue.assignee && agentIdOf(issue.assignee.sub) ? activeRunOf(issue.id) : undefined
    if (run) endRun(run, 'canceled', 'reassigned', time)
    change('assignee', issue.assignee ? actorView(issue.assignee) : null, assigned.assignee ? actorView(assigned.assignee) : null)
    issue.assignee = assigned.assignee
    if ((assigned.delegator?.sub ?? null) !== (issue.delegator?.sub ?? null)) {
      change('delegator', issue.delegator, assigned.delegator)
    }
    issue.delegator = assigned.delegator
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
  if (nextEstimate !== issue.estimate) {
    change('estimate', issue.estimate, nextEstimate)
    issue.estimate = nextEstimate
  }
  if (sprintChanged) {
    const after = sprintById(nextSprintId)
    change('sprint', currentSprint ? refOfSprint(currentSprint) : null, after ? refOfSprint(after) : null)
    issue.sprintId = nextSprintId
  }
  writeLedger(issue.id, before, standingOf(issue), time)
  if (fields.length > 0) {
    issue.updatedAt = time
    emit('issue.updated', issue, { fields: [...new Set(fields)] }, time)
  }
  return json(full(issue))
}

/** An activity as readers see it: the actor, and assignee values, resolved to current agent names and state. */
function activityView(activity: Activity): Activity {
  const resolve = (value: unknown) => (activity.field === 'assignee' && value && typeof value === 'object' ? actorView(value as Actor) : value)
  return { ...activity, actor: actorView(activity.actor), from: resolve(activity.from), to: resolve(activity.to) }
}

/** Activities, comments, runs (at `startedAt`) and requests (at `createdAt`), ascending. */
function timeline(issue: StoredIssue): Response {
  const stamped: [string, string, TimelineItem][] = [
    ...state.activities.filter((activity) => activity.issueId === issue.id).map((activity): [string, string, TimelineItem] => [activity.createdAt, activity.id, { kind: 'activity', activity: activityView(activity) }]),
    ...state.comments.filter((comment) => comment.issueId === issue.id && !comment.deleted).map((comment): [string, string, TimelineItem] => [comment.createdAt, comment.id, { kind: 'comment', comment: commentView(comment) }]),
    ...state.runs.filter((run) => run.issueId === issue.id).map((run): [string, string, TimelineItem] => [run.startedAt, run.id, { kind: 'run', run: runView(run) }]),
    ...state.requests.filter((request) => request.issueId === issue.id).map((request): [string, string, TimelineItem] => [request.createdAt, request.id, { kind: 'request', request: requestView(request) }]),
  ]
  stamped.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  return json({ items: stamped.map(([, , item]) => item) })
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
    uploader: who().actor,
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
  return state.views.filter((view) => view.shared || view.ownerSub === who().actor.sub).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
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

// --- sprints (API.md v0.1.10) -------------------------------------------------------

function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

function sprintInputProblem(input: Record<string, unknown>): Problem | undefined {
  const unknownKey = Object.keys(input).find((key) => !['name', 'goal', 'startsOn', 'lengthWeeks'].includes(key))
  if (unknownKey) return { path: unknownKey, message: `unknown field ${unknownKey}` }
  if ('name' in input && (typeof input.name !== 'string' || !input.name.trim() || Array.from(input.name.trim()).length > SPRINT_NAME_MAX)) return { path: 'name', message: `name must be 1–${SPRINT_NAME_MAX} characters` }
  if ('goal' in input && (typeof input.goal !== 'string' || bytes(input.goal) > SPRINT_GOAL_MAX_BYTES)) return { path: 'goal', message: `goal must be at most ${SPRINT_GOAL_MAX_BYTES} bytes` }
  if ('startsOn' in input && !isDay(input.startsOn)) return { path: 'startsOn', message: 'startsOn must be YYYY-MM-DD' }
  if ('lengthWeeks' in input && !SPRINT_LENGTHS.includes(input.lengthWeeks as SprintLength)) return { path: 'lengthWeeks', message: 'lengthWeeks must be 1 or 2' }
  return undefined
}

/** `?unit=` (default points) and `?project=` (an id or `none`: only events of issues currently in that project). */
function chartScope(url: URL): { unit: Unit; keep: (issueId: string) => boolean } | Problem {
  const unit = (url.searchParams.get('unit') ?? 'points') as Unit
  if (!UNITS.includes(unit)) return { path: 'unit', message: 'unit must be points or issues' }
  const project = url.searchParams.get('project')
  if (!project) return { unit, keep: () => true }
  const projectOf = (issueId: string) => state.issues.find((issue) => issue.id === issueId)?.projectId ?? null
  return { unit, keep: (issueId) => (project === 'none' ? projectOf(issueId) === null : projectOf(issueId) === project) }
}

function burndownOf(sprint: StoredSprint, unit: Unit, keep: (issueId: string) => boolean): Burndown {
  const zone = state.workspace.timezone
  const rows = state.sprintEvents.filter((event) => event.sprintId === sprint.id && keep(event.issueId)).map((event) => ({ day: dayInZone(event.at, zone), tally: event.tally }))
  const baseline = ledgerSum(sprint.id, sprint.startedAt ?? undefined, keep)
  const day = today()
  return { sprint: refOfSprint(sprint), unit, today: day, points: burndownPoints({ startsOn: sprint.startsOn, endsOn: sprint.endsOn, today: day, unit, baseline, rows, closed: sprintState(sprint) === 'closed' }) }
}

function velocityOf(unit: Unit, keep: (issueId: string) => boolean, limit: number): Velocity {
  const entries: VelocityEntry[] = state.sprints
    .filter((sprint) => sprintState(sprint) === 'closed')
    .sort((a, b) => a.closedAt!.localeCompare(b.closedAt!))
    .map((sprint) => ({ sprint: refOfSprint(sprint), lengthWeeks: sprint.lengthWeeks, committed: scopeIn(ledgerSum(sprint.id, sprint.startedAt!, keep), unit), completed: doneIn(ledgerSum(sprint.id, undefined, keep), unit) }))
  return { unit, items: entries.slice(-limit), averagePerWeek: averagePerWeek(entries) }
}

/** Moves `issue` to `sprintId` (null = backlog) at `time`: `sprint` activity and the ledger rows of the open sprints involved. */
function moveToSprint(issue: StoredIssue, sprintId: string | null, time: string) {
  const before = standingOf(issue)
  const from = sprintById(issue.sprintId)
  const to = sprintById(sprintId)
  record(issue, 'sprint', from ? refOfSprint(from) : null, to ? refOfSprint(to) : null, time)
  issue.sprintId = sprintId
  issue.updatedAt = time
  writeLedger(issue.id, before, standingOf(issue), time)
}

async function sprintRoutes(request: Request, url: URL, route: string): Promise<Response | undefined> {
  let match: RegExpMatchArray | null
  if (route === 'GET /velocity') {
    const scope = chartScope(url)
    if (isProblem(scope)) return invalid(scope.path, scope.message)
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam === null ? VELOCITY_LIMIT_DEFAULT : Number(limitParam)
    if (!Number.isInteger(limit) || limit < 1 || limit > VELOCITY_LIMIT_MAX) return invalid('limit', `limit must be between 1 and ${VELOCITY_LIMIT_MAX}`)
    return json(velocityOf(scope.unit, scope.keep, limit))
  }
  if (route === 'GET /sprints') {
    const wanted = url.searchParams.get('state')
    if (wanted !== null && !['planned', 'active', 'closed'].includes(wanted)) return invalid('state', 'state must be planned, active or closed')
    const items = state.sprints.map(sprintView).filter((sprint) => wanted === null || sprint.state === wanted)
    return json({ items: items.sort(compareSprints) })
  }
  if (route === 'POST /sprints') {
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    const problem = sprintInputProblem(input)
    if (problem) return invalid(problem.path, problem.message)
    const lengthWeeks = (input.lengthWeeks as SprintLength | undefined) ?? state.workspace.sprintLengthWeeks
    const latest = openSprints().sort((a, b) => b.endsOn.localeCompare(a.endsOn))[0]
    const startsOn = (input.startsOn as string | undefined) ?? (latest ? addDays(latest.endsOn, 1) : comingMonday(today()))
    const endsOn = endsOnFor(startsOn, lengthWeeks)
    if (overlapsAny({ startsOn, endsOn }, openSprints())) return conflict('the dates overlap another sprint that is not closed')
    const time = now()
    const number = Math.max(0, ...state.sprints.map((sprint) => sprint.number)) + 1
    const sprint: StoredSprint = {
      id: nextId(),
      number,
      name: typeof input.name === 'string' ? input.name.trim() : `Sprint ${number}`,
      goal: (input.goal as string | undefined) ?? '',
      lengthWeeks,
      startsOn,
      endsOn,
      startedAt: null,
      closedAt: null,
      createdAt: time,
      updatedAt: time,
    }
    state.sprints.push(sprint)
    return json(sprintView(sprint), 201)
  }
  if ((match = route.match(/^(GET|PATCH|DELETE) \/sprints\/([^/]+)$/))) {
    const [, method, rawId] = match
    const sprint = sprintById(decodeURIComponent(rawId!))
    if (!sprint) return notFound()
    if (method === 'GET') return json(sprintView(sprint))
    if (method === 'DELETE') {
      if (!isAdmin()) return forbidden()
      if (sprintState(sprint) !== 'planned') return conflict('only a planned sprint can be deleted')
      const time = now()
      for (const issue of live().filter((candidate) => candidate.sprintId === sprint.id)) moveToSprint(issue, null, time)
      state.sprintEvents = state.sprintEvents.filter((event) => event.sprintId !== sprint.id)
      state.sprints = state.sprints.filter((candidate) => candidate !== sprint)
      return noContent()
    }
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    const problem = sprintInputProblem(input)
    if (problem) return invalid(problem.path, problem.message)
    if (('startsOn' in input || 'lengthWeeks' in input) && sprintState(sprint) !== 'planned') return conflict('dates change only while the sprint is planned')
    const startsOn = (input.startsOn as string | undefined) ?? sprint.startsOn
    const lengthWeeks = (input.lengthWeeks as SprintLength | undefined) ?? sprint.lengthWeeks
    const endsOn = endsOnFor(startsOn, lengthWeeks)
    if (overlapsAny({ startsOn, endsOn }, openSprints().filter((other) => other !== sprint))) return conflict('the dates overlap another sprint that is not closed')
    if (typeof input.name === 'string') sprint.name = input.name.trim()
    if (typeof input.goal === 'string') sprint.goal = input.goal
    Object.assign(sprint, { startsOn, lengthWeeks, endsOn, updatedAt: now() })
    return json(sprintView(sprint))
  }
  if ((match = route.match(/^(POST|GET) \/sprints\/([^/]+)\/(start|close|burndown)$/))) {
    const [, method, rawId, action] = match
    const sprint = sprintById(decodeURIComponent(rawId!))
    if (!sprint) return notFound()
    if (method === 'GET' && action === 'burndown') {
      const scope = chartScope(url)
      if (isProblem(scope)) return invalid(scope.path, scope.message)
      return json(burndownOf(sprint, scope.unit, scope.keep))
    }
    if (method !== 'POST' || action === 'burndown') return notFound()
    // Sprint start and close stay with people (API.md "Agents", Authorization).
    if (who().agent) return forbidden()
    if (action === 'start') {
      if (sprintState(sprint) !== 'planned') return conflict('only a planned sprint can be started')
      if (activeSprint()) return conflict('another sprint is active; close it first')
      // A start before the planned date moves the sprint to today, keeping its length.
      const startsOn = sprint.startsOn > today() ? today() : sprint.startsOn
      const endsOn = endsOnFor(startsOn, sprint.lengthWeeks)
      if (overlapsAny({ startsOn, endsOn }, openSprints().filter((other) => other !== sprint))) return conflict('starting today would overlap another sprint that is not closed')
      const time = now()
      Object.assign(sprint, { startsOn, endsOn, startedAt: time, updatedAt: time })
      return json(sprintView(sprint))
    }
    const input = await body(request)
    if (!input || !('moveIncompleteTo' in input) || (input.moveIncompleteTo !== null && typeof input.moveIncompleteTo !== 'string')) return invalid('moveIncompleteTo', 'moveIncompleteTo must be a planned sprint id or null')
    if (sprintState(sprint) !== 'active') return conflict('only the active sprint can be closed')
    const target = input.moveIncompleteTo === null ? null : sprintById(input.moveIncompleteTo as string)
    if (input.moveIncompleteTo !== null && (!target || sprintState(target) !== 'planned')) return invalid('moveIncompleteTo', 'moveIncompleteTo must be a planned sprint id or null')
    const time = now()
    Object.assign(sprint, { closedAt: time, updatedAt: time })
    // Unfinished scope moves; the closed sprint takes no rows, so the move is on the target's ledger only. A relative already in the target sends an issue to the backlog.
    const unfinished = live().filter((issue) => issue.sprintId === sprint.id && categoryOf(issue.statusId) !== 'completed' && categoryOf(issue.statusId) !== 'canceled')
    for (const issue of unfinished) moveToSprint(issue, target && lineageMembers(issue.id, issue.parentId, target.id) === 0 ? target.id : null, time)
    return json(sprintView(sprint))
  }
  return undefined
}

// --- agents, runs, requests, inbox, events (API.md "Agents") --------------------------------

const IDEMPOTENCY_TTL_MS = 24 * HOUR
const EVENTS_LIMIT_DEFAULT = 100
const EVENTS_LIMIT_MAX = 500
const REQUEST_OPTION_MAX = 200

const runById = (id: string | null) => (id ? state.runs.find((run) => run.id === id) : undefined)
const requestById = (id: string) => state.requests.find((request) => request.id === id)
/** The parts of a stored request the pure rules read. */
const requestShape = (request: StoredRequest) => ({ kind: request.kind, state: request.state, from: { sub: request.fromSub }, to: request.toSub === null ? null : { sub: request.toSub } })

/** `domain.Actionable` for one agent over one live issue. */
function actionableFor(issue: StoredIssue, agentSubject: string): boolean {
  const run = activeRunOf(issue.id)
  return isActionable({
    deleted: issue.deleted,
    category: categoryOf(issue.statusId),
    activeRun: run ? { state: derived(run), agent: { sub: agentSub(run.agentId) } } : null,
    agentSub: agentSubject,
    ownOpenRequest: state.requests.some((request) => request.issueId === issue.id && request.fromSub === agentSubject && request.state === 'open' && !(request.runId && runById(request.runId) && isStalledRun(runById(request.runId)!))),
    openBlocker: state.blocks.some((block) => block.blockedId === issue.id && issueById(block.blockerId) !== undefined && !closedStatus(issueById(block.blockerId)!.statusId)),
  })
}

/** The caller's queue: open requests for them (oldest first), then unacknowledged answers and mentions (newest first), then — for agents — actionable assignments. */
function inboxOf(caller: Caller): InboxItem[] {
  const me = caller.actor
  const requests = state.requests
    .filter((request) => issueById(request.issueId) && isAddressedTo(requestShape(request), me))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((request): InboxItem => ({ kind: 'request', request: requestView(request) }))
  const answers = state.requests
    .filter((request) => issueById(request.issueId) && request.fromSub === me.sub && request.state === 'answered' && !request.answerAcked)
    .map((request): [string, InboxItem] => [request.answer!.at, { kind: 'answer', request: requestView(request) }])
  const mentions = state.mentions
    .filter((mention) => mention.targetSub === me.sub && !mention.acked)
    .flatMap((mention): [string, InboxItem][] => {
      const comment = state.comments.find((candidate) => candidate.id === mention.commentId && !candidate.deleted)
      const issue = issueById(mention.issueId)
      return comment && issue ? [[comment.createdAt, { kind: 'mention', comment: commentView(comment), issue: ref(issue) }]] : []
    })
  const updates = [...answers, ...mentions].sort((a, b) => b[0].localeCompare(a[0])).map(([, item]) => item)
  const assignments = caller.agent
    ? live()
        .filter((issue) => issue.assignee?.sub === me.sub && actionableFor(issue, me.sub))
        .map(summary)
        .sort(compareActionable(activeSprint()?.id ?? null))
        .map((issue): InboxItem => ({ kind: 'assignment', issue }))
    : []
  return [...requests, ...updates, ...assignments]
}

function agentInputProblem(input: Record<string, unknown>, creating: boolean): Problem | undefined {
  const known = creating ? ['handle', 'name', 'description', 'ownerSub'] : ['name', 'description', 'ownerSub', 'disabled']
  if (!creating && 'handle' in input) return { path: 'handle', message: 'handle is immutable' }
  const unknownKey = Object.keys(input).find((key) => !known.includes(key))
  if (unknownKey) return { path: unknownKey, message: `unknown field ${unknownKey}` }
  if (creating && (typeof input.handle !== 'string' || !AGENT_HANDLE_PATTERN.test(input.handle))) return { path: 'handle', message: 'handle must match ^[a-z][a-z0-9-]{1,30}$' }
  if ((creating || 'name' in input) && (typeof input.name !== 'string' || !input.name.trim() || Array.from(input.name.trim()).length > AGENT_NAME_MAX)) return { path: 'name', message: `name must be 1–${AGENT_NAME_MAX} characters` }
  if ('description' in input && (typeof input.description !== 'string' || bytes(input.description) > AGENT_DESCRIPTION_MAX_BYTES)) return { path: 'description', message: `description must be at most ${AGENT_DESCRIPTION_MAX_BYTES} bytes` }
  if ((creating || 'ownerSub' in input) && (typeof input.ownerSub !== 'string' || !input.ownerSub || agentIdOf(input.ownerSub) !== null)) return { path: 'ownerSub', message: 'ownerSub must name a person' }
  if ('disabled' in input && typeof input.disabled !== 'boolean') return { path: 'disabled', message: 'disabled must be a boolean' }
  return undefined
}

const isHttpsUrl = (value: unknown) => {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function linksProblem(value: unknown): Problem | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > RUN_LINKS_MAX) return { path: 'links', message: `links must be a list of at most ${RUN_LINKS_MAX}` }
  for (const [index, link] of value.entries()) {
    const candidate = link as Partial<Link> | null
    if (!candidate || !['pr', 'commit', 'url'].includes(candidate.kind as string)) return { path: `links.${index}.kind`, message: 'kind must be pr, commit or url' }
    if (!isHttpsUrl(candidate.url)) return { path: `links.${index}.url`, message: 'url must be an https URL' }
    if (typeof candidate.title !== 'string' || Array.from(candidate.title).length > LINK_TITLE_MAX) return { path: `links.${index}.title`, message: `title must be at most ${LINK_TITLE_MAX} characters` }
  }
  return undefined
}

const textProblem = (input: Record<string, unknown>, key: string, max: number): Problem | undefined =>
  key in input && (typeof input[key] !== 'string' || Array.from(input[key] as string).length > max) ? { path: key, message: `${key} must be at most ${max} characters` } : undefined

/** The agent protocol for an agent, generated from the routes it uses. */
function agentGuide(): string {
  const rows: [string, string][] = [
    ['GET /inbox', 'Your queue: requests addressed to you, answers to your requests, mentions, then the issues assigned to you that you can act on (an `assignment` carries `activeRun` when you already hold a live run: resume it, do not start again).'],
    ['POST /inbox/ack', '`{ answers?: requestIds, mentions?: commentIds }` once you have read them.'],
    ['POST /issues/{id}/runs', '`{ session?, note? }` starts a run on an issue assigned to you. The lease is 10 minutes.'],
    ['POST /runs/{id}/heartbeat', '`{ note? }` renews the lease; say what you are doing in the note. A 409 means the run ended or stalled: stop and start a fresh run.'],
    ['POST /issues/{id}/requests', '`{ kind: "question" | "approval", title, body?, options?, to?, runId? }`. Omit `to` to ask your delegator; `to: null` asks any person. With `runId` the run waits until every request is answered.'],
    ['POST /runs/{id}/finish', '`{ outcome: "succeeded" | "failed", summary, links? }`. Under the review policy a success opens a review for your delegator; only their approval completes the issue.'],
    ['POST /runs/{id}/cancel', 'Give up a run (yours, or a stalled one).'],
    ['GET /events?after=<seq>', 'Every change in commit order; keep the last `next` as your cursor.'],
  ]
  return [
    '# Working in Tracker as an agent',
    '',
    `Exchange your Access Key for an assertion (\`apth access-keys exchange\`), then call \`${BASE}\` with \`Authorization: Bearer <assertion>\`. \`GET\` needs \`tracker:read\`; every other method \`tracker:write\`. Send an \`Idempotency-Key\` header on every \`POST\` so a retry never acts twice.`,
    '',
    `Completion policy of this workspace: \`${state.workspace.agentCompletion}\`.`,
    '',
    '| Route | What it does |',
    '| --- | --- |',
    ...rows.map(([route, text]) => `| \`${route}\` | ${text} |`),
    '',
  ].join('\n')
}

async function agentRoutes(request: Request, url: URL, route: string): Promise<Response | undefined> {
  const caller = who()
  let match: RegExpMatchArray | null

  if (route === 'GET /agent-guide') return new Response(agentGuide(), { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' } })

  // Agents
  if (route === 'GET /agents') {
    const includeDisabled = url.searchParams.get('includeDisabled') === 'true'
    return json({ items: state.agents.filter((agent) => includeDisabled || !agent.disabled).sort((a, b) => a.handle.localeCompare(b.handle)).map(agentView) })
  }
  if (route === 'POST /agents') {
    if (!isAdmin()) return forbidden()
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    const problem = agentInputProblem(input, true)
    if (problem) return invalid(problem.path, problem.message)
    if (state.agents.some((agent) => agent.handle === input.handle)) return conflict('an agent with this handle exists')
    const time = now()
    const agent: StoredAgent = { id: nextId(), handle: input.handle as string, name: (input.name as string).trim(), description: (input.description as string | undefined) ?? '', owner: personFor(input.ownerSub as string), disabled: false, registeredByKey: null, createdAt: time, updatedAt: time, lastSeenAt: null }
    state.agents.push(agent)
    return json(agentView(agent), 201)
  }
  if ((match = route.match(/^PATCH \/agents\/([^/]+)$/))) {
    const agent = agentById(decodeURIComponent(match[1]!))
    if (!agent) return notFound()
    if (!isAdmin()) return forbidden()
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    const problem = agentInputProblem(input, false)
    if (problem) return invalid(problem.path, problem.message)
    const time = now()
    if (typeof input.name === 'string') agent.name = input.name.trim()
    if (typeof input.description === 'string') agent.description = input.description
    if (typeof input.ownerSub === 'string') agent.owner = personFor(input.ownerSub)
    if (input.disabled === true && !agent.disabled) {
      for (const run of state.runs.filter((candidate) => candidate.agentId === agent.id && !isTerminalRun(candidate.state))) endRun(run, 'canceled', `canceled_by:${caller.actor.sub}`, time)
    }
    if (typeof input.disabled === 'boolean') agent.disabled = input.disabled
    agent.updatedAt = time
    return json(agentView(agent))
  }

  // Inbox and events
  if (route === 'GET /inbox') return json({ items: inboxOf(caller) })
  if (route === 'POST /inbox/ack') {
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    for (const key of ['answers', 'mentions'] as const) if (key in input && !isStringArray(input[key])) return invalid(key, `${key} must list ids`)
    for (const id of (input.answers as string[] | undefined) ?? []) {
      const stored = requestById(id)
      if (stored && stored.fromSub === caller.actor.sub && stored.state === 'answered') stored.answerAcked = true
    }
    for (const id of (input.mentions as string[] | undefined) ?? []) {
      for (const mention of state.mentions) if (mention.commentId === id && mention.targetSub === caller.actor.sub) mention.acked = true
    }
    return noContent()
  }
  if (route === 'GET /events') {
    const afterParam = url.searchParams.get('after')
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam === null ? EVENTS_LIMIT_DEFAULT : Number(limitParam)
    if (!Number.isInteger(limit) || limit < 1 || limit > EVENTS_LIMIT_MAX) return invalid('limit', `limit must be between 1 and ${EVENTS_LIMIT_MAX}`)
    if (afterParam === null) return json({ items: [], next: state.eventSeq })
    const after = Number(afterParam)
    if (!Number.isInteger(after) || after < 0) return invalid('after', 'after must be a sequence number')
    const items = state.events.filter((event) => event.seq > after).slice(0, limit)
    return json({ items, next: items.at(-1)?.seq ?? after })
  }

  // Runs
  if ((match = route.match(/^(GET|POST) \/issues\/([^/]+)\/runs$/))) {
    const [, method, rawId] = match
    const issue = method === 'GET' ? findIssue(decodeURIComponent(rawId!)) : issueById(decodeURIComponent(rawId!))
    if (!issue) return notFound()
    if (method === 'GET') return json({ items: state.runs.filter((run) => run.issueId === issue.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)).map(runView) })
    if (!caller.agent || issue.assignee?.sub !== caller.actor.sub) return forbidden()
    const input = (await body(request)) ?? {}
    const problem = textProblem(input, 'session', RUN_TEXT_MAX) ?? textProblem(input, 'note', RUN_TEXT_MAX)
    if (problem) return invalid(problem.path, problem.message)
    const time = now()
    const current = activeRunOf(issue.id)
    if (current && !isStalledRun(current)) return conflict('another run is live on this issue')
    // A stalled run is never revived: the next start closes it.
    if (current) endRun(current, 'failed', 'lease_expired', time)
    const run: StoredRun = {
      id: nextId(),
      issueId: issue.id,
      agentId: caller.agent.id,
      state: 'running',
      reason: null,
      session: (input.session as string | undefined) ?? '',
      note: (input.note as string | undefined) ?? '',
      summary: '',
      links: [],
      startedAt: time,
      heartbeatAt: time,
      leaseExpiresAt: new Date(Date.parse(time) + LEASE_MS).toISOString(),
      finishedAt: null,
    }
    state.runs.push(run)
    emit('run.started', issue, run.id, time)
    return json(runView(run), 201)
  }
  if ((match = route.match(/^GET \/runs\/([^/]+)$/))) {
    const run = runById(decodeURIComponent(match[1]!))
    return run && issueById(run.issueId) ? json(runView(run)) : notFound()
  }
  if ((match = route.match(/^POST \/runs\/([^/]+)\/(heartbeat|finish|cancel)$/))) {
    const [, rawId, action] = match
    const run = runById(decodeURIComponent(rawId!))
    const issue = run ? issueById(run.issueId) : undefined
    if (!run || !issue) return notFound()
    const own = caller.agent?.id === run.agentId
    if (action === 'cancel') {
      if (!canCancelRun({ agent: { sub: agentSub(run.agentId) }, state: derived(run) }, caller.actor)) return isTerminalRun(run.state) ? conflict('the run has ended') : forbidden()
      endRun(run, 'canceled', `canceled_by:${caller.actor.sub}`, now())
      return json(runView(run))
    }
    if (!own) return forbidden()
    if (isTerminalRun(run.state)) return conflict('the run has ended')
    if (isStalledRun(run)) return conflict('the run stalled (its lease passed); start a fresh run')
    const input = (await body(request)) ?? {}
    if (action === 'heartbeat') {
      const problem = textProblem(input, 'note', RUN_TEXT_MAX)
      if (problem) return invalid(problem.path, problem.message)
      const time = now()
      Object.assign(run, { heartbeatAt: time, leaseExpiresAt: new Date(Date.parse(time) + LEASE_MS).toISOString() })
      if (typeof input.note === 'string') run.note = input.note
      return json(runView(run))
    }
    if (input.outcome !== 'succeeded' && input.outcome !== 'failed') return invalid('outcome', 'outcome must be succeeded or failed')
    if (typeof input.summary !== 'string' || bytes(input.summary) > RUN_SUMMARY_MAX_BYTES) return invalid('summary', `summary must be Markdown of at most ${RUN_SUMMARY_MAX_BYTES} bytes`)
    const links = linksProblem(input.links)
    if (links) return invalid(links.path, links.message)
    if (input.outcome === 'succeeded' && state.requests.some((stored) => stored.runId === run.id && stored.kind === 'approval' && stored.state === 'open')) return conflict('an approval of this run is still open; resolve or withdraw it first')
    const time = now()
    Object.assign(run, { state: input.outcome, summary: input.summary, links: ((input.links as Link[] | undefined) ?? []).map(({ kind, url: href, title }) => ({ kind, url: href, title })), finishedAt: time })
    if (input.outcome === 'failed') withdrawRunRequests(run, time)
    else withdrawRunRequests(run, time, ['question'])
    emit('run.finished', issue, run.id, time)
    if (input.outcome === 'succeeded' && state.workspace.agentCompletion === 'review') {
      const review: StoredRequest = {
        id: nextId(),
        issueId: issue.id,
        kind: 'review',
        fromSub: caller.actor.sub,
        toSub: issue.delegator?.sub ?? caller.agent!.owner.sub,
        title: `Review: ${issue.title}`,
        body: run.summary,
        options: [...DECISION_OPTIONS],
        runId: run.id,
        state: 'open',
        answer: null,
        createdAt: time,
        answerAcked: false,
      }
      state.requests.push(review)
      emit('request.opened', issue, review.id, time)
    }
    return json(runView(run))
  }

  // Requests
  if ((match = route.match(/^POST \/issues\/([^/]+)\/requests$/))) {
    const issue = issueById(decodeURIComponent(match[1]!))
    if (!issue) return notFound()
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    const unknownKey = Object.keys(input).find((key) => !['kind', 'title', 'body', 'options', 'to', 'runId'].includes(key))
    if (unknownKey) return invalid(unknownKey, `unknown field ${unknownKey}`)
    if (input.kind !== 'question' && input.kind !== 'approval') return invalid('kind', 'kind must be question or approval')
    if (typeof input.title !== 'string' || !input.title.trim() || Array.from(input.title.trim()).length > REQUEST_TITLE_MAX) return invalid('title', `title must be 1–${REQUEST_TITLE_MAX} characters`)
    if (input.body !== undefined && (typeof input.body !== 'string' || bytes(input.body) > REQUEST_BODY_MAX_BYTES)) return invalid('body', `body must be Markdown of at most ${REQUEST_BODY_MAX_BYTES} bytes`)
    let options: string[] = []
    if (input.kind === 'approval') {
      if (input.options !== undefined && JSON.stringify(input.options) !== JSON.stringify(DECISION_OPTIONS)) return invalid('options', 'an approval has the fixed options approve and reject')
      options = [...DECISION_OPTIONS]
    } else if (input.options !== undefined) {
      if (!isStringArray(input.options) || input.options.length > REQUEST_OPTIONS_MAX || input.options.some((option) => !option.trim() || Array.from(option).length > REQUEST_OPTION_MAX) || new Set(input.options).size !== input.options.length)
        return invalid('options', `options must be at most ${REQUEST_OPTIONS_MAX} distinct texts of 1–${REQUEST_OPTION_MAX} characters`)
      options = input.options
    }
    // `to` omitted: an agent asks its delegator here (else its owner); a person asks any person.
    let toSub: string | null
    if (input.to === undefined) toSub = caller.agent ? (issue.delegator?.sub ?? caller.agent.owner.sub) : null
    else if (input.to === null) toSub = null
    else if (typeof input.to !== 'string' || !input.to) return invalid('to', 'to must be a subject or null')
    else toSub = input.to
    if (toSub !== null) {
      const target = agentBySub(toSub)
      if (agentIdOf(toSub) !== null && (!target || target.disabled)) return invalid('to', 'to names no active agent')
      if (target && input.kind === 'approval') return invalid('to', 'an approval is answered by people only')
      if (toSub === caller.actor.sub) return invalid('to', 'a request goes to someone else')
    }
    let run: StoredRun | undefined
    if (input.runId !== undefined) {
      run = typeof input.runId === 'string' ? runById(input.runId) : undefined
      if (!run) return invalid('runId', 'unknown run')
      // Only the run's own agent attaches a request, and only to a run of this issue.
      if (caller.agent?.id !== run.agentId || run.issueId !== issue.id) return forbidden()
      if (isTerminalRun(run.state) || isStalledRun(run)) return conflict('the run is not live')
    }
    const time = now()
    const stored: StoredRequest = {
      id: nextId(),
      issueId: issue.id,
      kind: input.kind,
      fromSub: caller.actor.sub,
      toSub,
      title: input.title.trim(),
      body: (input.body as string | undefined) ?? '',
      options,
      runId: run?.id ?? null,
      state: 'open',
      answer: null,
      createdAt: time,
      answerAcked: false,
    }
    state.requests.push(stored)
    if (run) run.state = 'waiting'
    emit('request.opened', issue, stored.id, time)
    return json(requestView(stored), 201)
  }
  if (route === 'GET /requests') {
    const wanted = url.searchParams.get('state')
    if (wanted !== null && !['open', 'answered', 'withdrawn'].includes(wanted)) return invalid('state', 'state must be open, answered or withdrawn')
    const to = url.searchParams.get('to')
    const toSub = to === 'me' ? caller.actor.sub : to
    const issueKey = url.searchParams.get('issue')
    const issue = issueKey ? findIssue(issueKey) : undefined
    if (issueKey && !issue) return json({ items: [] })
    const items = state.requests
      .filter((stored) => issueById(stored.issueId) && (wanted === null || stored.state === wanted) && (toSub === null || stored.toSub === toSub) && (!issue || stored.issueId === issue.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map(requestView)
    return json({ items })
  }
  if ((match = route.match(/^GET \/requests\/([^/]+)$/))) {
    const stored = requestById(decodeURIComponent(match[1]!))
    return stored && issueById(stored.issueId) ? json(requestView(stored)) : notFound()
  }
  if ((match = route.match(/^POST \/requests\/([^/]+)\/(answer|withdraw)$/))) {
    const [, rawId, action] = match
    const stored = requestById(decodeURIComponent(rawId!))
    const issue = stored ? issueById(stored.issueId) : undefined
    if (!stored || !issue) return notFound()
    if (action === 'withdraw') {
      if (stored.fromSub !== caller.actor.sub) return forbidden()
      if (stored.state !== 'open') return conflict('the request is no longer open')
      const time = now()
      stored.state = 'withdrawn'
      emit('request.withdrawn', issue, stored.id, time)
      resumeIfClear(stored.runId)
      return json(requestView(stored))
    }
    if (stored.state !== 'open') return conflict('the request is no longer open')
    if (!canAnswer(requestShape(stored), { ...caller.actor, isAdmin: isAdmin() })) return forbidden()
    const input = (await body(request)) ?? {}
    if (input.option !== undefined && (typeof input.option !== 'string' || (stored.options.length > 0 ? !stored.options.includes(input.option) : true))) return invalid('option', stored.options.length > 0 ? `option must be one of ${stored.options.join(', ')}` : 'this request has no options')
    if (input.body !== undefined && (typeof input.body !== 'string' || bytes(input.body) > REQUEST_BODY_MAX_BYTES)) return invalid('body', `body must be Markdown of at most ${REQUEST_BODY_MAX_BYTES} bytes`)
    if (stored.kind !== 'question' && input.option === undefined) return invalid('option', 'choose approve or reject')
    if (input.option === undefined && !(input.body as string | undefined)?.trim()) return invalid('body', 'an answer needs an option or a text')
    const time = now()
    stored.state = 'answered'
    stored.answer = { option: (input.option as string | undefined) ?? null, body: (input.body as string | undefined) ?? '', bySub: caller.actor.sub, at: time }
    emit('request.answered', issue, stored.id, time)
    // Approving a review completes the issue as the person who approved, in the same write.
    const done = orderStatuses(state.statuses).find((status) => status.category === 'completed')
    if (stored.kind === 'review' && stored.answer.option === 'approve' && done && categoryOf(issue.statusId) !== 'completed') {
      const before = standingOf(issue)
      record(issue, 'status', issue.statusId, done.id, time)
      Object.assign(issue, { statusId: done.id, completedAt: time, updatedAt: time })
      writeLedger(issue.id, before, standingOf(issue), time)
      emit('issue.updated', issue, { fields: ['status'] }, time)
    }
    resumeIfClear(stored.runId)
    return json(requestView(stored))
  }
  return undefined
}

/** The request's caller: the signed-in person, or — with `X-Mock-Agent` — that agent's key (403 `key_subject` unless an active agent has the handle; 403 `insufficient_scope` without the method's scope). */
function callerOf(request: Request): Caller | Response {
  const handle = request.headers.get('X-Mock-Agent')
  if (handle === null) return { actor: personActor(state.caller), role: state.role, agent: null, scopes: ACCESS_KEY_SCOPES }
  const agent = state.agents.find((candidate) => candidate.handle === handle && !candidate.disabled)
  if (!agent) return fail(403, 'key_subject', "the key's external subject is not an active agent")
  const scopes = (request.headers.get('X-Mock-Scopes') ?? ACCESS_KEY_SCOPES.join(',')).split(',').map((scope) => scope.trim()).filter(Boolean)
  const needed = request.method === 'GET' ? 'tracker:read' : 'tracker:write'
  if (!scopes.includes(needed)) return fail(403, 'insufficient_scope', `the key lacks ${needed}`)
  agent.lastSeenAt = new Date(wallClock()).toISOString()
  return { actor: agentActor(agent), role: 'Viewer', agent, scopes }
}

/** `Idempotency-Key` on a POST (multipart attachment uploads excepted): the first response is kept 24 h per (actor, key) and replayed; the same key with another body → 409. */
async function idempotent(request: Request, handle: () => Promise<Response | undefined>): Promise<Response | undefined> {
  const multipart = (request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')
  const key = request.method === 'POST' && !multipart ? request.headers.get('Idempotency-Key') : null
  if (key === null) return handle()
  if (!key || key.length > IDEMPOTENCY_KEY_MAX) return invalid('Idempotency-Key', `Idempotency-Key must be 1–${IDEMPOTENCY_KEY_MAX} characters`)
  const sent = await request.clone().text()
  const slot = `${who().actor.sub}\n${key}`
  const at = wallClock()
  const stored = state.idempotency.get(slot)
  if (stored && at - stored.at < IDEMPOTENCY_TTL_MS) {
    if (stored.body !== sent) return conflict('this Idempotency-Key was used with a different body')
    return new Response(stored.status === 204 ? null : stored.response, { status: stored.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  }
  const response = await handle()
  if (!response) return response
  // Expired rows go when a new one is written.
  for (const [other, row] of state.idempotency) if (at - row.at >= IDEMPOTENCY_TTL_MS) state.idempotency.delete(other)
  state.idempotency.set(slot, { body: sent, status: response.status, response: await response.clone().text(), at })
  return response
}

/** Handles `/api/tracker/v1/*`; undefined for any other path. */
export async function trackerRoutes(request: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith(`${BASE}/`)) return undefined
  const route = `${request.method} ${url.pathname.slice(BASE.length)}`

  if (route === 'POST /__mock/reset') {
    const input = await body(request)
    state = seedAgents(seedTracker(input?.projects === 'none' ? { withProjects: false } : {}))
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
  if (route === 'POST /__mock/clock') {
    const input = await body(request)
    if (typeof input?.advanceMs !== 'number' || input.advanceMs < 0) return invalid('advanceMs', 'advanceMs must be a non-negative number')
    state.offset += input.advanceMs
    return json({ now: new Date(wallClock()).toISOString() })
  }
  if (route === 'GET /openapi.json') {
    const document = Bun.file(new URL('../../../cmd/server/internal/api/openapi.json', import.meta.url))
    return (await document.exists()) ? new Response(document, { headers: { 'Content-Type': 'application/json' } }) : json({ openapi: '3.1.0', info: { title: 'tracker', version: 'mock' }, paths: {} })
  }
  const caller = callerOf(request)
  if (caller instanceof Response) return caller
  return callerContext.run(caller, () => idempotent(request, () => routes(request, url, route)))
}

async function routes(request: Request, url: URL, route: string): Promise<Response | undefined> {
  let match: RegExpMatchArray | null
  if (route === 'GET /me') {
    const caller = who()
    return json({ ...caller.actor, role: caller.role, isAdmin: isAdmin(), ...(caller.agent ? { scopes: [...caller.scopes] } : {}) } satisfies Me)
  }

  // Workspace
  if (route === 'GET /workspace') return json(workspace())
  if (route === 'PATCH /workspace') {
    if (!isAdmin()) return forbidden()
    const input = await body(request)
    if (!input) return invalid('', 'A JSON object is required')
    if ('key' in input && (typeof input.key !== 'string' || !/^[A-Z][A-Z0-9]{1,5}$/.test(input.key))) return invalid('key', 'key must match ^[A-Z][A-Z0-9]{1,5}$')
    if ('name' in input && (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100)) return invalid('name', 'name must be 1–100 characters')
    if ('sprintLengthWeeks' in input && !SPRINT_LENGTHS.includes(input.sprintLengthWeeks as SprintLength)) return invalid('sprintLengthWeeks', 'sprintLengthWeeks must be 1 or 2')
    if ('timezone' in input && !isTimeZone(input.timezone)) return invalid('timezone', 'timezone must be an IANA time zone name')
    if ('agentCompletion' in input && !AGENT_COMPLETIONS.includes(input.agentCompletion as AgentCompletion)) return invalid('agentCompletion', 'agentCompletion must be review or direct')
    if (typeof input.agentCompletion === 'string') state.workspace.agentCompletion = input.agentCompletion as AgentCompletion
    if (typeof input.key === 'string') state.workspace.key = input.key
    if (typeof input.name === 'string') state.workspace.name = input.name.trim()
    if (typeof input.sprintLengthWeeks === 'number') state.workspace.sprintLengthWeeks = input.sprintLengthWeeks as SprintLength
    if (typeof input.timezone === 'string') state.workspace.timezone = input.timezone
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
    emit('issue.deleted', issue, issue.id, time)
    const before = standingOf(issue)
    issue.deleted = true
    writeLedger(issue.id, before, standingOf(issue), time)
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
      const comment: StoredComment = { id: nextId(), issueId: issue.id, author: who().actor, body: input.body, createdAt: now(), editedAt: null, deleted: false }
      state.comments.push(comment)
      // Mentions: one row per (comment, active agent) its `@handle`s name.
      const handles = parseMentions(input.body, state.agents.filter((agent) => !agent.disabled).map((agent) => agent.handle))
      for (const handle of handles) state.mentions.push({ commentId: comment.id, issueId: issue.id, targetSub: agentSub(state.agents.find((agent) => agent.handle === handle)!.id), acked: false })
      issue.updatedAt = comment.createdAt
      emit('comment.created', issue, comment.id, comment.createdAt)
      return json(commentView(comment), 201)
    }
    if (method === 'POST' && sub === 'attachments') return attach(issue, request)
    return notFound()
  }

  // Comments
  if ((match = route.match(/^(PATCH|DELETE) \/comments\/([^/]+)$/))) {
    const [, method, rawId] = match
    const comment = state.comments.find((candidate) => candidate.id === decodeURIComponent(rawId!) && !candidate.deleted)
    if (!comment || !issueById(comment.issueId)) return notFound()
    const mine = comment.author.sub === who().actor.sub
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
    return json(commentView(comment))
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
    if (attachment.uploader.sub !== who().actor.sub && !isAdmin()) return forbidden()
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
      owner: who().actor,
      ownerSub: who().actor.sub,
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
    if (view.shared ? !isAdmin() : view.ownerSub !== who().actor.sub) return forbidden()
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

  const sprints = await sprintRoutes(request, url, route)
  if (sprints) return sprints
  const agents = await agentRoutes(request, url, route)
  if (agents) return agents

  // People: Directory accepts only user bearers, so an agent's key gets nothing from it.
  if ((match = route.match(/^GET \/people\/([^/]+)\/avatar$/))) {
    if (who().agent) return fail(403, 'key_subject', "Directory's avatars need a person")
    if (match[1] !== 'person-alex' || process.env.MOCK_DIRECTORY === 'absent') return notFound()
    const version = url.searchParams.get('v') ?? ''
    const etag = `"${new Bun.CryptoHasher('sha256').update(version).update(new Uint8Array([0])).update(AVATAR_PNG).digest('hex')}"`
    const headers = { 'ETag': etag, 'Cache-Control': version ? 'private, max-age=86400' : 'private, no-cache', 'X-Content-Type-Options': 'nosniff' }
    if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers })
    return new Response(AVATAR_PNG, { headers: { ...headers, 'Content-Type': 'image/png' } })
  }
  if (route === 'GET /people') {
    if (process.env.MOCK_DIRECTORY === 'absent' || who().agent) return json({ items: [], source: 'unavailable' })
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const items = Object.values(MOCK_PEOPLE).filter((person) => !q || person.name.toLowerCase().includes(q) || person.sub.includes(q))
    return json({ items: items.slice(0, PEOPLE_LIMIT), source: 'directory' })
  }

  return notFound()
}
