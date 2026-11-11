import { describe, expect, test } from 'bun:test'
import type { IssueSummary, Sprint, Tally } from '../api/tracker'
import {
  addDays,
  averagePerWeek,
  burndownPoints,
  closeCounts,
  comingMonday,
  compareSprints,
  contribution,
  dayInZone,
  daysLeft,
  endsOnFor,
  groupBySprint,
  idealLine,
  isDay,
  lineageConflict,
  membershipProblem,
  overlapsAny,
  scopeOf,
  SIZE_POINTS,
  sizePoints,
  sprintChoiceProblem,
  sprintDeltas,
  suggestedCommitment,
  ZERO_TALLY,
  type SprintStanding,
} from './sprints'

const standing = (patch: Partial<SprintStanding> = {}): SprintStanding => ({ sprintId: 's1', size: 'M', category: 'started', deleted: false, ...patch })
const tally = (scopePoints: number, scopeIssues: number, donePoints = 0, doneIssues = 0): Tally => ({ scopePoints, scopeIssues, donePoints, doneIssues })

const issue = (number: number, patch: Partial<IssueSummary> = {}): IssueSummary => ({
  id: `id-${number}`,
  identifier: `APT-${number}`,
  number,
  title: `Issue ${number}`,
  type: 'task',
  priority: 'none',
  statusId: 'todo',
  assignee: null,
  reporter: { sub: 'dev-alex', name: 'Alex Chen', kind: 'person' },
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
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  completedAt: null,
  ...patch,
})
const ref = (number: number) => ({ id: `id-${number}`, identifier: `APT-${number}`, title: `Issue ${number}`, statusId: 'todo' })

const sprint = (number: number, patch: Partial<Sprint> = {}): Sprint => ({
  id: `s${number}`,
  number,
  name: `Sprint ${number}`,
  goal: '',
  state: 'planned',
  lengthWeeks: 1,
  startsOn: '2026-11-16',
  endsOn: '2026-11-22',
  startedAt: null,
  closedAt: null,
  current: ZERO_TALLY,
  commitment: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  ...patch,
})

describe('sizes and the ledger rule', () => {
  test('weights are the fixed Fibonacci scale; no estimate counts 0', () => {
    expect(SIZE_POINTS).toEqual({ XS: 1, S: 2, M: 3, L: 5, XL: 8 })
    expect(sizePoints(null)).toBe(0)
    expect(sizePoints('L')).toBe(5)
  })

  test('contribution: zero outside a sprint, deleted or canceled; done only in a completed status', () => {
    expect(contribution(standing())).toEqual(tally(3, 1))
    expect(contribution(standing({ category: 'completed' }))).toEqual(tally(3, 1, 3, 1))
    expect(contribution(standing({ size: null }))).toEqual(tally(0, 1))
    for (const zero of [standing({ sprintId: null }), standing({ deleted: true }), standing({ category: 'canceled' })]) expect(contribution(zero)).toEqual(ZERO_TALLY)
  })

  test('deltas: moving, estimating, completing, reopening, canceling and deleting are the same subtraction', () => {
    expect([...sprintDeltas(standing({ sprintId: null }), standing())]).toEqual([['s1', tally(3, 1)]])
    expect([...sprintDeltas(standing(), standing({ sprintId: 's2' }))]).toEqual([
      ['s1', tally(-3, -1)],
      ['s2', tally(3, 1)],
    ])
    expect([...sprintDeltas(standing(), standing({ size: 'XL' }))]).toEqual([['s1', tally(5, 0)]])
    expect([...sprintDeltas(standing(), standing({ category: 'completed' }))]).toEqual([['s1', tally(0, 0, 3, 1)]])
    expect([...sprintDeltas(standing({ category: 'completed' }), standing({ category: 'unstarted' }))]).toEqual([['s1', tally(0, 0, -3, -1)]])
    expect([...sprintDeltas(standing(), standing({ category: 'canceled' }))]).toEqual([['s1', tally(-3, -1)]])
    expect([...sprintDeltas(standing({ category: 'completed' }), standing({ category: 'completed', deleted: true }))]).toEqual([['s1', tally(-3, -1, -3, -1)]])
    // Zero tallies are omitted.
    expect(sprintDeltas(standing(), standing()).size).toBe(0)
    expect(sprintDeltas(standing({ category: 'canceled' }), standing({ category: 'canceled', size: 'XL' })).size).toBe(0)
  })
})

describe('membership', () => {
  test('an epic never joins, a closed sprint takes no one, a relative already there blocks', () => {
    expect(membershipProblem('epic', 'planned', 0)).toBe('epic')
    expect(membershipProblem('task', 'closed', 0)).toBe('closed')
    expect(membershipProblem('story', 'active', 1)).toBe('lineage')
    expect(membershipProblem('bug', 'active', 0)).toBeUndefined()
  })

  test('lineage from the refs a summary carries: parent, story, or a member whose parent or story the issue is', () => {
    const story = issue(33, { type: 'story' })
    const child = issue(4, { parent: ref(33), story: ref(33) })
    const grandchild = issue(7, { parent: ref(4), story: ref(33) })
    expect(lineageConflict(child, [story])?.id).toBe('id-33')
    expect(lineageConflict(story, [grandchild])?.id).toBe('id-7')
    expect(lineageConflict(grandchild, [child])?.id).toBe('id-4')
    expect(lineageConflict(child, [issue(9)])).toBeUndefined()
    expect(lineageConflict(child, [child])).toBeUndefined()
  })

  test('what the SPA offers: epics nothing, a closed sprint\'s member stays (frozen), the backlog otherwise always', () => {
    const active = sprint(4, { state: 'active' })
    const closed = sprint(3, { state: 'closed' })
    expect(sprintChoiceProblem(issue(1, { type: 'epic' }), active)).toBe('epic')
    expect(sprintChoiceProblem(issue(1, { type: 'epic' }), null)).toBeUndefined()
    const frozen = issue(2, { sprint: { id: 's3', number: 3, name: 'Sprint 3', state: 'closed' } })
    expect(sprintChoiceProblem(frozen, active)).toBe('frozen')
    expect(sprintChoiceProblem(frozen, null)).toBe('frozen')
    expect(sprintChoiceProblem(frozen, closed)).toBeUndefined()
    expect(sprintChoiceProblem(issue(5), closed)).toBe('closed')
    expect(sprintChoiceProblem(issue(4, { story: ref(33) }), active, [issue(33, { type: 'story' })])).toBe('lineage')
    expect(sprintChoiceProblem(issue(5), active, [issue(33)])).toBeUndefined()
  })
})

describe('dates in the workspace timezone', () => {
  test('calendar arithmetic, sprint end, default Monday, validation', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(endsOnFor('2026-11-16', 1)).toBe('2026-11-22')
    expect(endsOnFor('2026-11-16', 2)).toBe('2026-11-29')
    expect(comingMonday('2026-11-11')).toBe('2026-11-16')
    expect(comingMonday('2026-11-16')).toBe('2026-11-23')
    expect(comingMonday('2026-11-15')).toBe('2026-11-16')
    expect(isDay('2026-11-11')).toBe(true)
    expect(isDay('2026-02-30')).toBe(false)
    expect(isDay('11/11/2026')).toBe(false)
  })

  test('day boundaries are midnights in the zone', () => {
    expect(dayInZone('2026-11-10T14:59:00Z', 'Asia/Tokyo')).toBe('2026-11-10')
    expect(dayInZone('2026-11-10T15:00:00Z', 'Asia/Tokyo')).toBe('2026-11-11')
    expect(dayInZone('2026-11-10T15:00:00Z', 'UTC')).toBe('2026-11-10')
  })

  test('days left include today; overlap is any shared day', () => {
    const span = { startsOn: '2026-11-08', endsOn: '2026-11-21' }
    expect(daysLeft(span, '2026-11-11')).toBe(11)
    expect(daysLeft(span, '2026-11-21')).toBe(1)
    expect(daysLeft(span, '2026-11-25')).toBe(0)
    expect(daysLeft(span, '2026-11-01')).toBe(14)
    expect(overlapsAny({ startsOn: '2026-11-22', endsOn: '2026-11-28' }, [span])).toBe(false)
    expect(overlapsAny({ startsOn: '2026-11-21', endsOn: '2026-11-27' }, [span])).toBe(true)
  })
})

describe('burndown and velocity', () => {
  test('ideal falls only on weekdays: flat across Saturday and Sunday, 0 at the end', () => {
    // Monday to Sunday: four weekday steps after the start.
    expect(idealLine(10, ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'])).toEqual([10, 7.5, 5, 2.5, 0, 0, 0])
    // Wednesday to Tuesday crosses a weekend.
    expect(idealLine(6, ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'])).toEqual([6, 4.5, 3, 3, 3, 1.5, 0])
  })

  test('each day sums the rows up to it (planning rows count on day one); days after today keep only ideal', () => {
    const points = burndownPoints({
      startsOn: '2026-11-16',
      endsOn: '2026-11-22',
      today: '2026-11-18',
      unit: 'points',
      baseline: tally(10, 4),
      closed: false,
      rows: [
        { day: '2026-11-15', tally: tally(10, 4) },
        { day: '2026-11-17', tally: tally(2, 1) },
        { day: '2026-11-17', tally: tally(0, 0, 3, 1) },
        { day: '2026-11-18', tally: tally(-2, -1) },
      ],
    })
    expect(points.slice(0, 3)).toEqual([
      { day: '2026-11-16', scope: 10, done: 0, remaining: 10, ideal: 10 },
      { day: '2026-11-17', scope: 12, done: 3, remaining: 9, ideal: 7.5 },
      { day: '2026-11-18', scope: 10, done: 3, remaining: 7, ideal: 5 },
    ])
    expect(points[3]).toEqual({ day: '2026-11-19', ideal: 2.5 })
    expect(points).toHaveLength(7)
    // In issues, the same rows count issues.
    expect(burndownPoints({ startsOn: '2026-11-16', endsOn: '2026-11-16', today: '2026-11-16', unit: 'issues', baseline: tally(10, 4), closed: false, rows: [{ day: '2026-11-15', tally: tally(10, 4, 3, 1) }] })).toEqual([
      { day: '2026-11-16', scope: 4, done: 1, remaining: 3, ideal: 4 },
    ])
  })

  test('the last day of a closed sprint includes every row, even after its end date', () => {
    const points = burndownPoints({
      startsOn: '2026-11-02',
      endsOn: '2026-11-08',
      today: '2026-11-11',
      unit: 'points',
      baseline: tally(8, 2),
      closed: true,
      rows: [
        { day: '2026-11-01', tally: tally(8, 2) },
        { day: '2026-11-09', tally: tally(0, 0, 5, 1) },
      ],
    })
    expect(points[5]).toMatchObject({ day: '2026-11-07', done: 0 })
    expect(points[6]).toMatchObject({ day: '2026-11-08', done: 5, remaining: 3 })
  })

  test('average per week: the last three closed sprints, each divided by its length', () => {
    expect(averagePerWeek([])).toBeNull()
    expect(averagePerWeek([18, 21, 24].map((completed) => ({ completed, lengthWeeks: 1 as const })))).toBe(21)
    expect(averagePerWeek([{ completed: 99, lengthWeeks: 1 }, { completed: 18, lengthWeeks: 1 }, { completed: 30, lengthWeeks: 2 }, { completed: 20, lengthWeeks: 1 }])).toBe(17.67)
    expect(suggestedCommitment(21, 2)).toBe(42)
    expect(suggestedCommitment(17.67, 1)).toBe(18)
    expect(suggestedCommitment(null, 1)).toBeNull()
  })
})

describe('sprint order, sections and counts', () => {
  test('active, then planned by start, then closed newest first', () => {
    const items = [sprint(1, { state: 'closed', startsOn: '2026-10-01' }), sprint(5, { startsOn: '2026-11-30' }), sprint(3, { state: 'closed', startsOn: '2026-10-15' }), sprint(4, { state: 'active', startsOn: '2026-11-08' }), sprint(6, { startsOn: '2026-11-23' })]
    expect([...items].sort(compareSprints).map((item) => item.number)).toEqual([4, 6, 5, 3, 1])
  })

  test('group by sprint: open sprints always (empty ones too), closed only with rows, backlog last; epics fall in the backlog', () => {
    const active = sprint(4, { state: 'active', startsOn: '2026-11-08' })
    const planned = sprint(5, { startsOn: '2026-11-22' })
    const closed = sprint(3, { state: 'closed', startsOn: '2026-11-01' })
    const rows = [issue(1, { sprint: { id: 's3', number: 3, name: 'Sprint 3', state: 'closed' } }), issue(2), issue(3, { sprint: { id: 's4', number: 4, name: 'Sprint 4', state: 'active' } }), issue(31, { type: 'epic' })]
    const sections = groupBySprint(rows, [planned, closed, active])
    expect(sections.map((section) => [section.key, section.issues.map((row) => row.number)])).toEqual([
      ['s4', [3]],
      ['s5', []],
      ['s3', [1]],
      ['none', [2, 31]],
    ])
    expect(sections[0]!.sprint).toBe(active)
    expect(sections[3]!.sprint).toBeNull()
    expect(groupBySprint([], [closed]).map((section) => section.key)).toEqual(['none'])
  })

  test('close counts: done (completed), unfinished (not done, not canceled); scope leaves canceled out', () => {
    const category = (statusId: string) => ({ done: 'completed', gone: 'canceled', todo: 'unstarted' }) [statusId] as 'completed' | 'canceled' | 'unstarted'
    const members = [issue(1, { statusId: 'done', estimate: 'XL' }), issue(2, { estimate: 'S' }), issue(3, { statusId: 'gone', estimate: 'L' }), issue(4)]
    expect(closeCounts(members, category)).toEqual({ done: 1, unfinished: 2 })
    expect(scopeOf(members, category, 'points')).toBe(10)
    expect(scopeOf(members, category, 'issues')).toBe(3)
  })
})
