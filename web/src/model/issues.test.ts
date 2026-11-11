import { describe, expect, test } from 'bun:test'
import type { Attachment, IssueRef, IssueSummary, Status, TimelineItem } from '../api/tracker'
import { attachmentProblem, attachmentsOf, canBeType, canParent, compactFilter, compareIssues, groupIssues, levelOf, matchesFilter, orderStatuses, parentLevelOf, reportProblems, tallyProgress, toReport } from './issues'

const statuses: Status[] = [
  { id: 'done', name: 'Done', category: 'completed', position: 0, color: 'green' },
  { id: 'todo', name: 'Todo', category: 'unstarted', position: 2, color: 'gray' },
  { id: 'backlog', name: 'Backlog', category: 'backlog', position: 5, color: 'gray' },
  { id: 'doing', name: 'Doing', category: 'started', position: 1, color: 'yellow' },
]

const issue = (number: number, patch: Partial<IssueSummary> = {}): IssueSummary => ({
  id: `id-${number}`,
  identifier: `APT-${number}`,
  number,
  title: `Issue ${number}`,
  type: 'task',
  priority: 'none',
  statusId: 'todo',
  assignee: null,
  reporter: { sub: 'dev-alex', name: 'Alex Chen' },
  labelIds: [],
  projectId: null,
  parent: null,
  epic: null,
  story: null,
  progress: null,
  dueOn: null,
  report: null,
  commentCount: 0,
  attachmentCount: 0,
  createdAt: `2026-10-${String(number).padStart(2, '0')}T00:00:00.000Z`,
  updatedAt: `2026-10-${String(number).padStart(2, '0')}T00:00:00.000Z`,
  completedAt: null,
  estimate: null,
  sprint: null,
  ...patch,
})

describe('issue rules', () => {
  test('statuses order by category first, then position', () => {
    expect(orderStatuses(statuses).map((status) => status.id)).toEqual(['backlog', 'todo', 'doing', 'done'])
  })

  test('sorts follow API.md: updated/created desc, priority urgent→none then updated, number asc', () => {
    const items = [issue(1, { priority: 'low', updatedAt: '2026-10-09T00:00:00.000Z' }), issue(2, { priority: 'urgent' }), issue(3, { priority: 'low' })]
    expect([...items].sort(compareIssues('updated')).map((item) => item.number)).toEqual([1, 3, 2])
    expect([...items].sort(compareIssues('created')).map((item) => item.number)).toEqual([3, 2, 1])
    expect([...items].sort(compareIssues('priority')).map((item) => item.number)).toEqual([2, 1, 3])
    expect([...items].sort(compareIssues('number')).map((item) => item.number)).toEqual([1, 2, 3])
    // estimate: XL → XS, unestimated last, ties by updated desc.
    const sized = [issue(1, { estimate: 'S' }), issue(2), issue(3, { estimate: 'XL' }), issue(4, { estimate: 'S' }), issue(5, { estimate: 'XS' })]
    expect([...sized].sort(compareIssues('estimate')).map((item) => item.number)).toEqual([3, 4, 1, 5, 2])
  })

  test('filters AND across facets and OR within one; me/none resolve against the caller', () => {
    const context = { me: 'dev-alex', statuses }
    const mine = issue(1, { assignee: { sub: 'dev-alex', name: 'Alex Chen' }, labelIds: ['ux'], statusId: 'doing' })
    const bug = issue(2, { type: 'bug', report: { environment: 'craftsman', surface: 'dashboard' }, parent: { id: 'id-1', identifier: 'APT-1', title: 'x', statusId: 'doing' } })
    expect(matchesFilter(mine, { assignee: ['me'] }, context)).toBe(true)
    expect(matchesFilter(bug, { assignee: ['me'] }, context)).toBe(false)
    expect(matchesFilter(bug, { assignee: ['none', 'me'] }, context)).toBe(true)
    expect(matchesFilter(mine, { reporter: ['me'] }, context)).toBe(true)
    expect(matchesFilter(mine, { reporter: ['dev-sam'] }, context)).toBe(false)
    expect(matchesFilter(mine, { reporter: ['dev-sam', 'me'] }, context)).toBe(true)
    expect(matchesFilter(issue(4, { reporter: { sub: 'dev-sam', name: 'Sam Rivera' } }), { reporter: ['me'], assignee: ['none'] }, context)).toBe(false)
    expect(matchesFilter(mine, { category: ['started'], label: ['ux', 'docs'] }, context)).toBe(true)
    expect(matchesFilter(mine, { category: ['started'], type: ['bug'] }, context)).toBe(false)
    expect(matchesFilter(bug, { environment: ['craftsman'], surface: ['dashboard'] }, context)).toBe(true)
    expect(matchesFilter(mine, { environment: ['craftsman'] }, context)).toBe(false)
    expect(matchesFilter(bug, { parent: 'none' }, context)).toBe(false)
    expect(matchesFilter(bug, { parent: 'id-1' }, context)).toBe(true)
    expect(matchesFilter(bug, { q: 'apt-2 issue' }, context)).toBe(true)
    expect(matchesFilter(bug, { createdAfter: '2026-10-02T00:00:00Z' }, context)).toBe(false)
    const scoped = issue(3, { projectId: 'p-dash' })
    expect(matchesFilter(scoped, { project: ['p-dash'] }, context)).toBe(true)
    expect(matchesFilter(scoped, { project: ['none'] }, context)).toBe(false)
    expect(matchesFilter(mine, { project: ['none', 'p-api'] }, context)).toBe(true)
    expect(matchesFilter(mine, { project: ['p-api'] }, context)).toBe(false)
    const bundled = issue(5, { epic: ref(31), story: ref(33) })
    expect(matchesFilter(bundled, { epic: ['id-31'] }, context)).toBe(true)
    expect(matchesFilter(bundled, { epic: ['none'] }, context)).toBe(false)
    expect(matchesFilter(mine, { epic: ['none', 'id-31'], story: ['none'] }, context)).toBe(true)
    expect(matchesFilter(bundled, { story: ['id-34'] }, context)).toBe(false)
    expect(matchesFilter(bundled, { epic: ['id-31'], story: ['id-33', 'id-34'] }, context)).toBe(true)
    // sprint: ids, `active` (resolved by the caller's context) and `none` (the backlog).
    const planned = issue(6, { sprint: { id: 's-5', number: 5, name: 'Sprint 5', state: 'planned' } })
    const running = issue(7, { sprint: { id: 's-4', number: 4, name: 'Sprint 4', state: 'active' } })
    expect(matchesFilter(planned, { sprint: ['s-5'] }, context)).toBe(true)
    expect(matchesFilter(running, { sprint: ['active'] }, { ...context, activeSprintId: 's-4' })).toBe(true)
    expect(matchesFilter(running, { sprint: ['active'] }, { ...context, activeSprintId: null })).toBe(false)
    expect(matchesFilter(planned, { sprint: ['active', 'none'] }, { ...context, activeSprintId: 's-4' })).toBe(false)
    expect(matchesFilter(mine, { sprint: ['none'] }, context)).toBe(true)
    expect(compactFilter({ status: [], q: '', label: ['ux'] })).toEqual({ label: ['ux'] })
  })

  test('hierarchy: epic 2 > story 1 > work items 0; a work item fits anywhere, others only under a higher level', () => {
    expect([levelOf('epic'), levelOf('story'), levelOf('bug'), levelOf('feature'), levelOf('task')]).toEqual([2, 1, 0, 0, 0])
    expect(canParent('epic', null)).toBe(true)
    expect(canParent('epic', 'epic')).toBe(false)
    expect(canParent('epic', 'task')).toBe(false)
    expect(canParent('story', 'epic')).toBe(true)
    expect(canParent('story', 'story')).toBe(false)
    expect(canParent('story', 'bug')).toBe(false)
    for (const parent of ['epic', 'story', 'task', null] as const) expect(canParent('bug', parent)).toBe(true)

    // The parent's level comes from the derived refs.
    expect(parentLevelOf(issue(1))).toBeNull()
    expect(parentLevelOf(issue(1, { parent: ref(31), epic: ref(31) }))).toBe(2)
    expect(parentLevelOf(issue(1, { parent: ref(33), epic: ref(31), story: ref(33) }))).toBe(1)
    expect(parentLevelOf(issue(1, { parent: ref(7), epic: ref(31), story: ref(33) }))).toBe(0)
    // A type change checks the parent and every direct child.
    expect(canBeType('epic', 2, [])).toBe(false)
    expect(canBeType('story', 2, ['task'])).toBe(true)
    expect(canBeType('story', null, ['story'])).toBe(false)
    expect(canBeType('story', 0, [])).toBe(false)
    expect(canBeType('task', 1, ['story'])).toBe(false)
    expect(canBeType('task', 0, ['bug'])).toBe(true)
  })

  test('grouping: sections by epic/story ordered by number, "none" last; the grouping type and higher levels head sections, never rows', () => {
    const epicA = issue(31, { type: 'epic', progress: { total: 2, completed: 1, points: { total: 0, completed: 0 } } })
    const storyA = issue(33, { type: 'story', parent: ref(31), epic: ref(31), progress: { total: 1, completed: 0, points: { total: 0, completed: 0 } } })
    const emptyEpic = issue(32, { type: 'epic', progress: { total: 0, completed: 0, points: { total: 0, completed: 0 } } })
    const rows = [
      issue(9, { epic: ref(40), story: null }),
      issue(2, { epic: ref(31), story: ref(33) }),
      issue(3),
      issue(4, { epic: ref(31), story: null }),
    ]
    const items = [rows[0]!, storyA, epicA, rows[1]!, rows[2]!, emptyEpic, rows[3]!]
    expect(groupIssues(items, 'none')).toEqual([{ key: 'all', header: null, issues: items }])

    const byEpic = groupIssues(items, 'epic', [issue(40, { type: 'epic', title: 'Known epic' })])
    expect(byEpic.map((section) => [section.key, section.issues.map((row) => row.number)])).toEqual([
      ['id-31', [33, 2, 4]],
      ['id-32', []],
      ['id-40', [9]],
      ['none', [3]],
    ])
    expect(byEpic[0]!.header).toBe(epicA)
    // A group only referenced by rows takes its summary from `known`, else stays the ref.
    expect(byEpic[2]!.header).toMatchObject({ title: 'Known epic', type: 'epic' })
    expect(groupIssues(items, 'epic')[2]!.header).toEqual(ref(40))

    const byStory = groupIssues(items, 'story')
    expect(byStory.map((section) => [section.key, section.issues.map((row) => row.number)])).toEqual([
      ['id-33', [2]],
      ['none', [9, 3, 4]],
    ])
    expect(byStory[0]!.header).toBe(storyA)
    expect(groupIssues([], 'story')).toEqual([{ key: 'none', header: null, issues: [] }])
  })

  test('progress tally: work items only, canceled left out of the total, completed counted; points sum the sizes the same way', () => {
    const canceled: Status = { id: 'gone', name: 'Canceled', category: 'canceled', position: 9, color: 'gray' }
    const items = [
      issue(1, { statusId: 'done', estimate: 'M' }),
      issue(2, { estimate: 'XL' }),
      issue(3, { statusId: 'gone', estimate: 'L' }),
      issue(4, { type: 'story', statusId: 'done', estimate: 'S' }),
      issue(5, { type: 'bug', statusId: 'doing' }),
    ]
    expect(tallyProgress(items, [...statuses, canceled])).toEqual({ total: 3, completed: 1, points: { total: 11, completed: 3 } })
    expect(tallyProgress([], statuses)).toEqual({ total: 0, completed: 0, points: { total: 0, completed: 0 } })
  })

  test('attachments come from the timeline: added in `to`, removed in `from`', () => {
    const file = (id: string): Attachment => ({ id, issueId: 'i', filename: `${id}.png`, mediaType: 'image/png', size: 10, url: `/api/tracker/v1/attachments/${id}`, uploader: { sub: 'a', name: 'A' }, createdAt: '2026-10-01T00:00:00Z' })
    const activity = (id: string, from: unknown, to: unknown): TimelineItem => ({ kind: 'activity', activity: { id, issueId: 'i', actor: { sub: 'a', name: 'A' }, field: 'attachment', from, to, createdAt: '2026-10-01T00:00:00Z' } })
    expect(attachmentsOf([activity('1', null, file('a')), activity('2', null, file('b')), activity('3', file('a'), null)]).map((item) => item.id)).toEqual(['b'])
  })

  test('attachment limits: type, 2 MiB and 10 per issue', () => {
    expect(attachmentProblem({ size: 100, type: 'image/png' }, 0)).toBeUndefined()
    expect(attachmentProblem({ size: 100, type: 'image/gif' }, 0)).toBe('type')
    expect(attachmentProblem({ size: 2 * 1024 * 1024 + 1, type: 'image/png' }, 0)).toBe('tooLarge')
    expect(attachmentProblem({ size: 100, type: 'image/png' }, 10)).toBe('tooMany')
  })

  test('report form: title, environment and surface are required; blank optional texts are omitted', () => {
    const draft = { environment: ' craftsman ', surface: 'dashboard' as const, version: '0.1.0', steps: '', expected: ' ok ', actual: '' }
    expect(reportProblems('', { ...draft, environment: '', surface: '' })).toEqual({ title: 'required', environment: 'required', surface: 'required' })
    expect(reportProblems('a'.repeat(201), draft)).toEqual({ title: 'tooLong' })
    expect(reportProblems('Bug', { ...draft, steps: 'x'.repeat(4097) })).toEqual({ steps: 'tooLong' })
    expect(toReport(draft)).toEqual({ environment: 'craftsman', surface: 'dashboard', version: '0.1.0', expected: 'ok' })
  })
})

function ref(number: number): IssueRef {
  return { id: `id-${number}`, identifier: `APT-${number}`, title: `Issue ${number}`, statusId: 'todo' }
}
