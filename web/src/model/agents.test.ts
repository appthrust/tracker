import { describe, expect, test } from 'bun:test'
import type { Actor, IssueSummary, Run, Status, TrackerRequest } from '../api/tracker'
import {
  accessKeyCommand,
  accessKeyCommandFor,
  agentIdOf,
  canAnswer,
  canCancelRun,
  canWithdraw,
  compareActionable,
  deriveRunState,
  isActionable,
  isAddressedTo,
  isLiveRun,
  maySetCompleted,
  medianWaitMs,
  mentionAt,
  parseMentions,
  selfRegisterBody,
  selfRegisterRequest,
  SELF_REGISTER_PATH,
  type ActionableStanding,
} from './agents'
import { matchesFilter } from './issues'

const alex: Actor = { sub: 'dev-alex', name: 'Alex Chen', kind: 'person' }
const sam: Actor = { sub: 'dev-sam', name: 'Sam Rivera', kind: 'person' }
const astra: Actor = { sub: 'agent:A1', name: 'Astra', kind: 'agent', agent: { id: 'A1', handle: 'astra', owner: { sub: 'dev-sam', name: 'Sam Rivera' }, disabled: false } }
const claude: Actor = { sub: 'agent:C1', name: 'Claude', kind: 'agent', agent: { id: 'C1', handle: 'claude', owner: { sub: 'dev-jordan', name: 'Jordan Lee' }, disabled: false } }
const ref = { id: 'i1', identifier: 'APT-1', title: 'x', statusId: 'todo' }

const request = (patch: Partial<TrackerRequest> = {}): TrackerRequest => ({
  id: 'r1',
  issue: ref,
  kind: 'question',
  from: astra,
  to: alex,
  title: 'Which?',
  body: '',
  options: [],
  runId: null,
  state: 'open',
  answer: null,
  createdAt: '2026-11-11T00:00:00.000Z',
  ...patch,
})

const run = (patch: Partial<Run> = {}): Run => ({
  id: 'run1',
  issue: ref,
  agent: astra,
  state: 'running',
  reason: null,
  session: '',
  note: '',
  summary: '',
  links: [],
  startedAt: '2026-11-11T00:00:00.000Z',
  heartbeatAt: '2026-11-11T00:00:00.000Z',
  leaseExpiresAt: '2026-11-11T00:10:00.000Z',
  finishedAt: null,
  ...patch,
})

describe('agent rules', () => {
  test('subjects, and the platform command that mints a key for a handle', () => {
    expect(agentIdOf('agent:01ABC')).toBe('01ABC')
    expect(agentIdOf('dev-alex')).toBeNull()
    expect(accessKeyCommand('astra')).toBe('apth access-keys create --space tracker --external astra --scope tracker:read --scope tracker:write')
  })

  test('self-registration help: a key command only for a valid handle; a JSON body with exactly the given name and subject', () => {
    expect(accessKeyCommandFor('astra')).toBe(accessKeyCommand('astra'))
    for (const handle of ['', 'a', 'Astra', '9lives', 'astra bot', 'a'.repeat(32)]) expect(accessKeyCommandFor(handle), handle).toBeNull()
    const sub = 'auth0|"quoted"\\sub'
    expect(JSON.parse(selfRegisterBody('Astra “β”', sub))).toEqual({ name: 'Astra “β”', ownerSub: sub })
    const request = selfRegisterRequest('Astra', 'dev-alex')
    const [head, body] = request.split('\n\n')
    expect(head!.split('\n')[0]).toBe(`POST ${SELF_REGISTER_PATH}`)
    expect(SELF_REGISTER_PATH).toBe('/api/tracker/v1/agents/register')
    expect(JSON.parse(body!)).toEqual({ name: 'Astra', ownerSub: 'dev-alex' })
  })

  test('a non-terminal run whose lease has passed reads as stalled; terminal runs never do', () => {
    const lease = '2026-11-11T00:10:00.000Z'
    expect(deriveRunState('running', lease, Date.parse(lease) - 1)).toBe('running')
    expect(deriveRunState('running', lease, Date.parse(lease))).toBe('stalled')
    expect(deriveRunState('waiting', lease, Date.parse(lease) + 1)).toBe('stalled')
    expect(deriveRunState('succeeded', lease, Date.parse(lease) + 1)).toBe('succeeded')
    expect(isLiveRun({ state: 'waiting' })).toBe(true)
    expect(isLiveRun({ state: 'stalled' })).toBe(false)
    expect(isLiveRun(null)).toBe(false)
  })

  test('who may answer: questions by their addressee; approvals and reviews by people only (addressee, anyone when unaddressed, Admin)', () => {
    expect(canAnswer(request(), alex)).toBe(true)
    expect(canAnswer(request(), sam)).toBe(false)
    expect(canAnswer(request({ to: claude, from: alex }), claude)).toBe(true)
    expect(canAnswer(request({ to: null }), sam)).toBe(true)
    expect(canAnswer(request({ to: null }), claude)).toBe(false)
    expect(canAnswer(request({ kind: 'review' }), alex)).toBe(true)
    expect(canAnswer(request({ kind: 'review' }), sam)).toBe(false)
    expect(canAnswer(request({ kind: 'review' }), { ...sam, isAdmin: true })).toBe(true)
    expect(canAnswer(request({ kind: 'approval', to: null }), sam)).toBe(true)
    expect(canAnswer(request({ kind: 'approval', to: null }), claude)).toBe(false)
    expect(canAnswer(request({ state: 'answered' }), alex)).toBe(false)
  })

  test('withdraw is the requester’s; cancel is any person’s or the run’s agent’s, until the run ends', () => {
    expect(canWithdraw(request(), astra)).toBe(true)
    expect(canWithdraw(request(), alex)).toBe(false)
    expect(canCancelRun(run(), sam)).toBe(true)
    expect(canCancelRun(run({ state: 'stalled' }), astra)).toBe(true)
    expect(canCancelRun(run(), claude)).toBe(false)
    expect(canCancelRun(run({ state: 'canceled' }), sam)).toBe(false)
  })

  test('inbox addressing and the completion policy', () => {
    expect(isAddressedTo(request(), alex)).toBe(true)
    expect(isAddressedTo(request({ to: null }), sam)).toBe(true)
    expect(isAddressedTo(request({ to: null, from: sam }), sam)).toBe(false)
    expect(isAddressedTo(request({ to: null }), claude)).toBe(false)
    expect(maySetCompleted('person', 'review')).toBe(true)
    expect(maySetCompleted('agent', 'review')).toBe(false)
    expect(maySetCompleted('agent', 'direct')).toBe(true)
  })

  test('Actionable: open categories, no live run of another agent, no own open request, no open blocker', () => {
    const base: ActionableStanding = { deleted: false, category: 'backlog', activeRun: null, agentSub: astra.sub, ownOpenRequest: false, openBlocker: false }
    expect(isActionable(base)).toBe(true)
    expect(isActionable({ ...base, category: 'completed' })).toBe(false)
    expect(isActionable({ ...base, deleted: true })).toBe(false)
    expect(isActionable({ ...base, activeRun: { state: 'running', agent: claude } })).toBe(false)
    expect(isActionable({ ...base, activeRun: { state: 'stalled', agent: claude } })).toBe(true)
    expect(isActionable({ ...base, activeRun: { state: 'running', agent: astra } })).toBe(true)
    expect(isActionable({ ...base, ownOpenRequest: true })).toBe(false)
    expect(isActionable({ ...base, openBlocker: true })).toBe(false)
    const issues = [
      { number: 3, priority: 'low' as const, sprint: null },
      { number: 2, priority: 'low' as const, sprint: { id: 's4' } },
      { number: 9, priority: 'urgent' as const, sprint: null },
      { number: 1, priority: 'low' as const, sprint: null },
    ]
    expect([...issues].sort(compareActionable('s4')).map((issue) => issue.number)).toEqual([9, 2, 1, 3])
  })

  test('mentions: known handles once each; the word being typed after @', () => {
    expect(parseMentions('@astra please, @astra again, cc @claude and a@astra.dev @nobody', ['astra', 'claude'])).toEqual(['astra', 'claude'])
    expect(parseMentions('(@claude)', ['claude'])).toEqual(['claude'])
    expect(mentionAt('ping @ast', 9)).toEqual({ start: 5, query: 'ast' })
    expect(mentionAt('ping @', 6)).toEqual({ start: 5, query: '' })
    expect(mentionAt('mail a@ast', 10)).toBeNull()
    expect(mentionAt('done @astra now', 15)).toBeNull()
  })

  test('median wait counts answered agent requests answered by people', () => {
    const answered = (minutes: number, by: Actor = alex): TrackerRequest => request({ state: 'answered', answer: { option: null, body: 'ok', by, at: new Date(Date.parse('2026-11-11T00:00:00.000Z') + minutes * 60_000).toISOString() } })
    expect(medianWaitMs([])).toBeNull()
    expect(medianWaitMs([answered(10), answered(30), answered(20), answered(5, claude), request()])).toBe(20 * 60_000)
    expect(medianWaitMs([answered(10), answered(20)])).toBe(15 * 60_000)
  })

  test('filter facets: assignee kind, agent, run and request', () => {
    const statuses: Status[] = [{ id: 'todo', name: 'Todo', category: 'unstarted', position: 0, color: 'gray' }]
    const summary = (patch: Partial<IssueSummary>): IssueSummary => ({
      id: 'i1',
      identifier: 'APT-1',
      number: 1,
      title: 'x',
      type: 'task',
      priority: 'none',
      statusId: 'todo',
      assignee: null,
      reporter: alex,
      delegator: null,
      activeRun: null,
      openRequestCount: 0,
      labelIds: [],
      projectId: null,
      parent: null,
      epic: null,
      story: null,
      progress: null,
      estimate: null,
      sprint: null,
      dueOn: null,
      report: null,
      commentCount: 0,
      attachmentCount: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      completedAt: null,
      ...patch,
    })
    const context = { me: 'dev-alex', statuses, raisedOpenRequest: (issue: IssueSummary) => issue.id === 'mine' }
    const working = summary({ assignee: astra, activeRun: run() })
    const stalled = summary({ assignee: astra, activeRun: run({ state: 'stalled' }), openRequestCount: 1, id: 'mine' })
    const person = summary({ assignee: sam })
    expect(matchesFilter(working, { assigneeKind: ['agent'] }, context)).toBe(true)
    expect(matchesFilter(person, { assigneeKind: ['agent'] }, context)).toBe(false)
    expect(matchesFilter(summary({}), { assigneeKind: ['person'] }, context)).toBe(false)
    expect(matchesFilter(working, { agent: ['A1'] }, context)).toBe(true)
    expect(matchesFilter(working, { agent: ['C1'] }, context)).toBe(false)
    expect(matchesFilter(working, { run: ['active'] }, context)).toBe(true)
    expect(matchesFilter(stalled, { run: ['active'] }, context)).toBe(false)
    expect(matchesFilter(stalled, { run: ['stalled'] }, context)).toBe(true)
    expect(matchesFilter(person, { run: ['none'] }, context)).toBe(true)
    expect(matchesFilter(stalled, { request: ['open'] }, context)).toBe(true)
    expect(matchesFilter(working, { request: ['open'] }, context)).toBe(false)
    expect(matchesFilter(stalled, { request: ['mine'] }, context)).toBe(true)
    expect(matchesFilter(working, { request: ['mine', 'open'] }, context)).toBe(false)
  })
})
