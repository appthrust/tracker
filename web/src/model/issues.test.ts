import { describe, expect, test } from 'bun:test'
import type { Attachment, IssueSummary, Status, TimelineItem } from '../api/tracker'
import { attachmentProblem, attachmentsOf, compactFilter, compareIssues, matchesFilter, orderStatuses, reportProblems, toReport } from './issues'

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
  dueOn: null,
  report: null,
  commentCount: 0,
  attachmentCount: 0,
  createdAt: `2026-10-${String(number).padStart(2, '0')}T00:00:00.000Z`,
  updatedAt: `2026-10-${String(number).padStart(2, '0')}T00:00:00.000Z`,
  completedAt: null,
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
  })

  test('filters AND across facets and OR within one; me/none resolve against the caller', () => {
    const context = { me: 'dev-alex', statuses }
    const mine = issue(1, { assignee: { sub: 'dev-alex', name: 'Alex Chen' }, labelIds: ['ux'], statusId: 'doing' })
    const bug = issue(2, { type: 'bug', report: { environment: 'craftsman', surface: 'dashboard' }, parent: { id: 'id-1', identifier: 'APT-1', title: 'x', statusId: 'doing' } })
    expect(matchesFilter(mine, { assignee: ['me'] }, context)).toBe(true)
    expect(matchesFilter(bug, { assignee: ['me'] }, context)).toBe(false)
    expect(matchesFilter(bug, { assignee: ['none', 'me'] }, context)).toBe(true)
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
    expect(compactFilter({ status: [], q: '', label: ['ux'] })).toEqual({ label: ['ux'] })
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
