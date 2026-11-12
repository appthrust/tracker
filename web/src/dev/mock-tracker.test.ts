import { beforeEach, describe, expect, test } from 'bun:test'
import type { Agent, Attachment, Burndown, InboxItem, Issue, IssuePage, IssueSummary, Label, Project, Run, Sprint, Status, TimelineItem, TrackerEvent, TrackerRequest, Velocity, View } from '../api/tracker'
import { addDays, dayInZone } from '../model/sprints'
import { MOCK_PEOPLE, trackerRoutes } from './mock-tracker'

const BASE = '/api/tracker/v1'

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = new URL(`${BASE}${path}`, 'http://mock.test')
  const init: RequestInit = { method, headers: { ...headers } }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { ...headers, 'Content-Type': 'application/json' }
  }
  const response = await trackerRoutes(new Request(url, init), url)
  if (!response) throw new Error(`unhandled ${method} ${path}`)
  const type = response.headers.get('Content-Type') ?? ''
  // Contract assertions read many differently shaped responses; `toMatchObject`/`toEqual` check the shape at runtime.
  const parsed: any = response.status === 204 ? undefined : type.includes('json') ? await response.json() : await response.arrayBuffer() // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: parsed, headers: response.headers }
}

const as = (sub: string, role: 'Admin' | 'Editor' = 'Editor') => call('POST', '/__mock/caller', { sub, role })
const list = async (query = '') => (await call('GET', `/issues${query}`)).body as IssuePage
const filterQuery = (filter: object, extra = '') => `?filter=${encodeURIComponent(JSON.stringify(filter))}${extra}`
const statuses = async () => (await call('GET', '/statuses')).body.items as Status[]
const statusNamed = async (name: string) => (await statuses()).find((status) => status.name === name)!
const projects = async (query = '') => (await call('GET', `/projects${query}`)).body.items as Project[]
const projectNamed = async (name: string) => (await projects('?includeArchived=true')).find((project) => project.name === name)!

beforeEach(async () => {
  expect(await call('POST', '/__mock/reset')).toMatchObject({ status: 200, body: { reset: true } })
})

describe('tracker mock: fixture shared with the server dev seed', () => {
  test('caller, workspace, statuses, labels, views and people', async () => {
    expect((await call('GET', '/me')).body).toEqual({ ...MOCK_PEOPLE.alex, kind: 'person', role: 'Admin', isAdmin: true })
    expect((await call('GET', '/workspace')).body).toMatchObject({ key: 'APT', issueCount: 42, sprintLengthWeeks: 1, timezone: 'Asia/Tokyo', agentCompletion: 'review' })
    expect((await statuses()).map((status) => [status.name, status.category, status.color, status.position])).toEqual([
      ['Backlog', 'backlog', 'gray', 0],
      ['Todo', 'unstarted', 'gray', 1],
      ['In Progress', 'started', 'yellow', 2],
      ['In Review', 'started', 'blue', 3],
      ['Done', 'completed', 'green', 4],
      ['Canceled', 'canceled', 'gray', 5],
    ])
    expect(((await call('GET', '/labels')).body.items as Label[]).map((label) => [label.name, label.color])).toEqual([
      ['docs', 'blue'],
      ['regression', 'red'],
      ['ux', 'purple'],
    ])
    const views = (await call('GET', '/views')).body.items as View[]
    expect(views.map((view) => [view.name, view.shared, view.layout, view.groupBy, view.filter])).toEqual([
      ['Bugs', true, 'list', 'none', { type: ['bug'] }],
      ['My issues', true, 'list', 'none', { assignee: ['me'] }],
      ['By epic', true, 'board', 'epic', {}],
    ])
    expect((await call('GET', '/people?q=sam')).body).toEqual({ items: [MOCK_PEOPLE.sam], source: 'directory' })
    expect((await call('GET', '/people')).body.items).toHaveLength(3)
  })

  test('Directory avatars use the authenticated same-origin route and versioned private caching', async () => {
    const path = MOCK_PEOPLE.alex.avatarUrl.slice(BASE.length)
    const image = await call('GET', path)
    expect(image.status).toBe(200)
    expect(image.headers.get('Content-Type')).toBe('image/png')
    expect(image.headers.get('Cache-Control')).toBe('private, max-age=86400')
    expect(new Uint8Array(image.body).slice(0, 4)).toEqual(new Uint8Array([137, 80, 78, 71]))
    const url = new URL(`${BASE}${path}`, 'http://mock.test')
    const cached = await trackerRoutes(new Request(url, { headers: { 'If-None-Match': image.headers.get('ETag')! } }), url)
    expect(cached?.status).toBe(304)
    expect((await call('GET', '/people/person-alex/avatar')).headers.get('Cache-Control')).toBe('private, no-cache')
    expect(await call('GET', '/people/person-sam/avatar')).toMatchObject({ status: 404, body: { error: 'not_found' } })
  })

  test('issue i follows the seed formula: status i%6, type i%3, priority i%5, reporter i%3, assignee (i+1)%3', async () => {
    const all = (await list('?sort=number')).items.slice(0, 30)
    expect(all).toHaveLength(30)
    const ordered = await statuses()
    const first = all[0]!
    expect(first).toMatchObject({ identifier: 'APT-1', title: 'Dashboard loses filters on reload', type: 'bug', priority: 'urgent', statusId: ordered[0]!.id, reporter: MOCK_PEOPLE.alex, assignee: MOCK_PEOPLE.sam })
    expect(first.report).toEqual({ environment: 'appthrust.ink', surface: 'dashboard', version: '0.1.0', steps: 'Open the affected surface and repeat the action.', expected: 'The action completes successfully.', actual: 'The observed behavior differs from the expected result.' })
    expect(all[4]).toMatchObject({ identifier: 'APT-5', type: 'feature', priority: 'none', statusId: ordered[4]!.id, report: null, completedAt: expect.any(String) })
    expect(new Set(all.map((issue) => issue.statusId)).size).toBe(6)
    expect(new Set(all.map((issue) => issue.type))).toEqual(new Set(['bug', 'feature', 'task']))
  })
})

describe('tracker mock: issues', () => {
  test('filter, sort and cursor paging; malformed parameters are 400 invalid', async () => {
    // Ten seeded bugs plus APT-42, reported by astra.
    expect((await list(filterQuery({ type: ['bug'] }))).items).toHaveLength(11)
    expect((await list(filterQuery({ assignee: ['me'] }))).items.every((issue) => issue.assignee?.sub === 'dev-alex')).toBe(true)
    expect((await list(filterQuery({ category: ['started'] }))).items).toHaveLength(16)
    expect((await list(filterQuery({ q: 'cluster' }))).items.map((issue) => issue.identifier).sort()).toEqual(['APT-10', 'APT-28', 'APT-3'])
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: IssuePage = await list(`?sort=number&limit=12${cursor ? `&cursor=${cursor}` : ''}`)
      seen.push(...page.items.map((issue) => issue.identifier))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toHaveLength(42)
    expect(seen[0]).toBe('APT-1')
    expect(new Set(seen).size).toBe(42)
    const urgentFirst = (await list('?sort=priority')).items
    expect(urgentFirst.slice(0, 6).every((issue) => issue.priority === 'urgent')).toBe(true)
    for (const bad of ['?filter=%7Bnope', filterQuery({ colour: ['red'] }), filterQuery({ type: ['initiative'] }), filterQuery({ epic: ['APT-31'] }), filterQuery({ story: 'none' }), '?sort=title', '?limit=500']) {
      const { status, body } = await call('GET', `/issues${bad}`)
      expect(status, bad).toBe(400)
      expect(body.error).toBe('invalid')
      expect(body.issues[0].path).toBeTruthy()
    }
  })

  test('reporter filter: subjects OR `me` (the caller), newest first; more than 20 or an empty subject is 400 invalid', async () => {
    const mine = (await list(`${filterQuery({ reporter: ['me'] })}&sort=created`)).items
    expect(mine.length).toBeGreaterThanOrEqual(8)
    expect(mine.every((issue) => issue.reporter.sub === MOCK_PEOPLE.alex.sub)).toBe(true)
    expect(mine.map((issue) => issue.createdAt)).toEqual(mine.map((issue) => issue.createdAt).sort().reverse())
    expect((await list(filterQuery({ reporter: ['dev-alex'] }))).items).toHaveLength(mine.length)
    const either = (await list(filterQuery({ reporter: ['me', 'dev-sam'] }))).items
    expect(new Set(either.map((issue) => issue.reporter.sub))).toEqual(new Set(['dev-alex', 'dev-sam']))
    const bugs = (await list(filterQuery({ reporter: ['me'], type: ['bug'] }))).items
    expect(bugs.length).toBeGreaterThan(0)
    expect(bugs.every((issue) => issue.type === 'bug' && issue.reporter.sub === 'dev-alex')).toBe(true)

    // A new issue is reported by whoever is signed in; a newcomer has reported nothing yet.
    await as('dev-sam')
    expect((await list(filterQuery({ reporter: ['me'] }))).items.every((issue) => issue.reporter.sub === 'dev-sam')).toBe(true)
    expect((await call('POST', '/__mock/caller', { sub: 'dev-riley' })).status).toBe(400)
    expect((await call('POST', '/__mock/caller', { sub: 'dev-riley', name: 'Riley Park' })).status).toBe(200)
    expect((await list(filterQuery({ reporter: ['me'] }))).items).toEqual([])
    const created = (await call('POST', '/issues', { title: 'First report', type: 'bug', report: { environment: 'craftsman', surface: 'dashboard' } })).body as Issue
    expect(created.reporter).toEqual({ sub: 'dev-riley', name: 'Riley Park', kind: 'person' })
    expect((await list(filterQuery({ reporter: ['me'] }))).items.map((issue) => issue.identifier)).toEqual([created.identifier])

    const subjects = Array.from({ length: 21 }, (_, i) => `dev-${i}`)
    for (const bad of [{ reporter: subjects }, { reporter: [''] }, { reporter: 'me' }]) {
      const { status, body } = await call('GET', `/issues${filterQuery(bad)}`)
      expect(status, JSON.stringify(bad)).toBe(400)
      expect(body).toMatchObject({ error: 'invalid', issues: [{ path: 'filter.reporter' }] })
    }
    expect((await list(filterQuery({ reporter: subjects.slice(0, 20) }))).items).toEqual([])
    expect((await call('POST', '/views', { name: 'Bad', filter: { reporter: [''] } })).status).toBe(400)
  })

  test('GET by identifier (any case) or id; unknown is 404', async () => {
    const issue = (await call('GET', '/issues/apt-3')).body as Issue
    expect(issue).toMatchObject({ identifier: 'APT-3', children: [], blocks: [], blockedBy: [] })
    expect((await call('GET', `/issues/${issue.id}`)).body.identifier).toBe('APT-3')
    expect((await call('GET', '/issues/APT-999')).status).toBe(404)
    expect((await call('GET', '/issues/XYZ-3')).status).toBe(404)
  })

  test('POST: bugs need a report, default status is the first backlog status, the next number is used', async () => {
    expect((await call('POST', '/issues', { title: 'x', type: 'bug' })).body.issues[0].path).toBe('report')
    expect((await call('POST', '/issues', { title: ' ', type: 'task' })).status).toBe(400)
    expect((await call('POST', '/issues', { title: 'x', type: 'task', report: { environment: 'local', surface: 'apth' } })).status).toBe(400)
    const created = await call('POST', '/issues', { title: '  Board drag fails  ', type: 'bug', priority: 'high', report: { environment: 'craftsman', surface: 'dashboard', version: '0.1.0', steps: '' } })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ identifier: 'APT-43', title: 'Board drag fails', statusId: (await statusNamed('Backlog')).id, reporter: { ...MOCK_PEOPLE.alex, kind: 'person' }, report: { environment: 'craftsman', surface: 'dashboard', version: '0.1.0' }, estimate: null, sprint: null })
    expect(created.body.report.steps).toBeUndefined()
    expect((await call('GET', '/workspace')).body.issueCount).toBe(43)
  })

  test('PATCH: one activity per changed field, completion time, links and cycle checks', async () => {
    const issue = (await call('GET', '/issues/APT-2')).body as Issue
    const done = await statusNamed('Done')
    // APT-2 is assigned to Jordan by the seed; the duplicated label and the unchanged priority are no-ops.
    const patched = await call('PATCH', `/issues/${issue.id}`, { statusId: done.id, assigneeSub: 'dev-alex', labelIds: [issue.labelIds[0]!, issue.labelIds[0]!], priority: issue.priority })
    expect(patched.status).toBe(200)
    expect(patched.body).toMatchObject({ statusId: done.id, assignee: MOCK_PEOPLE.alex, completedAt: expect.any(String) })
    const timeline = (await call('GET', `/issues/${issue.id}/timeline`)).body.items as TimelineItem[]
    const fields = timeline.flatMap((item) => (item.kind === 'activity' ? [item.activity.field] : []))
    expect(fields).toEqual(['created', 'status', 'assignee'])
    const status = timeline.find((item) => item.kind === 'activity' && item.activity.field === 'status')
    expect(status?.kind === 'activity' && status.activity).toMatchObject({ from: issue.statusId, to: done.id, actor: MOCK_PEOPLE.alex })
    expect((await call('PATCH', `/issues/${issue.id}`, { statusId: (await statusNamed('Todo')).id })).body.completedAt).toBeNull()
    expect((await call('PATCH', `/issues/${issue.id}`, { assigneeSub: null })).body.assignee).toBeNull()

    const parent = (await call('GET', '/issues/APT-1')).body as Issue
    // APT-2 is in the active sprint with APT-1's story (APT-34): lineage-exclusive until it leaves the sprint.
    expect((await call('PATCH', `/issues/${issue.id}`, { parentId: parent.id })).body.issues[0].path).toBe('sprintId')
    await call('PATCH', `/issues/${issue.id}`, { sprintId: null })
    expect((await call('PATCH', `/issues/${issue.id}`, { parentId: parent.id })).body.parent.identifier).toBe('APT-1')
    expect((await call('GET', '/issues/APT-1')).body.children.map((child: { identifier: string }) => child.identifier)).toEqual(['APT-2'])
    expect((await call('PATCH', `/issues/${parent.id}`, { parentId: issue.id })).body.issues[0]).toEqual({ path: 'parentId', message: 'parent would create a cycle' })
    expect((await call('PATCH', `/issues/${issue.id}`, { blocks: [parent.id] })).body.blocks.map((ref: { identifier: string }) => ref.identifier)).toEqual(['APT-1'])
    expect((await call('GET', '/issues/APT-1')).body.blockedBy.map((ref: { identifier: string }) => ref.identifier)).toEqual(['APT-2'])
    expect((await call('PATCH', `/issues/${parent.id}`, { blocks: [issue.id] })).status).toBe(400)
    expect((await call('PATCH', `/issues/${issue.id}`, { blocks: [issue.id] })).status).toBe(400)
    expect((await call('PATCH', `/issues/${issue.id}`, { colour: 'red' })).status).toBe(400)
    // PATCH addresses issues by id; identifiers are for reads.
    expect((await call('PATCH', '/issues/APT-2', { title: 'x' })).status).toBe(404)
  })

  test('PATCH type: leaving bug clears the report, becoming a bug requires one', async () => {
    const bug = (await call('GET', '/issues/APT-1')).body as Issue
    const task = await call('PATCH', `/issues/${bug.id}`, { type: 'task' })
    expect(task.body).toMatchObject({ type: 'task', report: null })
    expect((await call('PATCH', `/issues/${bug.id}`, { type: 'bug' })).body.issues[0].path).toBe('report')
    expect((await call('PATCH', `/issues/${bug.id}`, { type: 'bug', report: { environment: 'local', surface: 'other' } })).body.report).toEqual({ environment: 'local', surface: 'other' })
  })

  test('DELETE is Admin only and hides the issue everywhere', async () => {
    const issue = (await call('GET', '/issues/APT-4')).body as Issue
    await as('dev-sam')
    expect((await call('DELETE', `/issues/${issue.id}`)).status).toBe(403)
    await as('dev-alex', 'Admin')
    expect((await call('DELETE', `/issues/${issue.id}`)).status).toBe(204)
    expect((await call('GET', '/issues/APT-4')).status).toBe(404)
    expect((await list()).items).toHaveLength(41)
  })
})

describe('tracker mock: epics and stories', () => {
  const byNumber = async () => new Map((await list('?sort=number')).items.map((issue) => [issue.number, issue]))

  test('fixture: 2 epics, 4 stories (two per epic) In Progress; seed issue n with n%5 != 0 sits under stories[n%4]', async () => {
    const issues = await byNumber()
    const inProgress = await statusNamed('In Progress')
    const epics = [issues.get(31)!, issues.get(32)!]
    const stories = [33, 34, 35, 36].map((number) => issues.get(number)!)
    expect(epics.map((epic) => [epic.type, epic.title, epic.statusId, epic.parent, epic.epic, epic.story])).toEqual([
      ['epic', 'Reliable bug intake', inProgress.id, null, null, null],
      ['epic', 'Faster triage', inProgress.id, null, null, null],
    ])
    expect(stories.map((story) => [story.type, story.parent?.id, story.epic?.id, story.story])).toEqual([
      ['story', epics[0]!.id, epics[0]!.id, null],
      ['story', epics[0]!.id, epics[0]!.id, null],
      ['story', epics[1]!.id, epics[1]!.id, null],
      ['story', epics[1]!.id, epics[1]!.id, null],
    ])
    expect(stories.every((story) => story.title.startsWith('As a'))).toBe(true)
    expect(epics.concat(stories).every((issue) => issue.reporter.sub === 'dev-alex' && issue.assignee === null && issue.priority === 'medium' && issue.projectId === null)).toBe(true)
    for (let n = 1; n <= 30; n++) {
      const issue = issues.get(n)!
      const story = n % 5 === 0 ? null : stories[n % 4]!
      expect([issue.parent?.id ?? null, issue.story?.id ?? null, issue.progress], issue.identifier).toEqual([story?.id ?? null, story?.id ?? null, null])
      expect(issue.epic?.id ?? null, issue.identifier).toBe(story ? epics[Math.floor((n % 4) / 2)]!.id : null)
    }
  })

  test('progress counts level-0 descendants at any depth: canceled excluded from total, completed counted; points sum their sizes', async () => {
    const issues = await byNumber()
    const category = new Map((await statuses()).map((status) => [status.id, status.category]))
    const weight = (issue: IssueSummary) => (issue.estimate ? { XS: 1, S: 2, M: 3, L: 5, XL: 8 }[issue.estimate] : 0)
    const expected = (inGroup: (issue: IssueSummary) => boolean) => {
      const counted = [...issues.values()].filter((issue) => issue.number <= 30 && inGroup(issue) && category.get(issue.statusId) !== 'canceled')
      const completed = counted.filter((issue) => category.get(issue.statusId) === 'completed')
      const points = (items: IssueSummary[]) => items.reduce((sum, issue) => sum + weight(issue), 0)
      return { total: counted.length, completed: completed.length, points: { total: points(counted), completed: points(completed) } }
    }
    const epic = issues.get(31)!
    const story = issues.get(33)!
    expect(story.progress).toEqual(expected((issue) => issue.story?.id === story.id))
    expect(epic.progress).toEqual(expected((issue) => issue.epic?.id === epic.id))
    expect(epic.progress!.total).toBeGreaterThan(story.progress!.total)
    expect(epic.progress!.points.total).toBeGreaterThan(0)

    // A completed sub-task two levels below its story counts there and in the epic.
    const parentTask = issues.get(1)!
    const subTask = (await call('POST', '/issues', { title: 'Sub-task', type: 'task', parentId: parentTask.id, statusId: (await statusNamed('Done')).id })).body as Issue
    expect(subTask).toMatchObject({ epic: { id: parentTask.epic!.id }, story: { id: parentTask.story!.id }, progress: null })
    for (const group of [parentTask.story!, parentTask.epic!]) {
      const before = [...issues.values()].find((issue) => issue.id === group.id)!.progress!
      expect(((await call('GET', `/issues/${group.id}`)).body as Issue).progress).toEqual({ ...before, total: before.total + 1, completed: before.completed + 1 })
    }
  })

  test('a deleted issue ends the hierarchy: no epic/story through it, and its subtree leaves progress', async () => {
    const story = (await call('GET', '/issues/APT-33')).body as Issue
    const parentTask = (await call('POST', '/issues', { title: 'Parent', type: 'task', parentId: story.id })).body as Issue
    const child = (await call('POST', '/issues', { title: 'Child', type: 'task', parentId: parentTask.id })).body as Issue
    expect(((await call('GET', `/issues/${story.id}`)).body as Issue).progress!.total).toBe(story.progress!.total + 2)
    expect((await call('DELETE', `/issues/${parentTask.id}`)).status).toBe(204)
    expect((await call('GET', `/issues/${child.id}`)).body).toMatchObject({ parent: null, epic: null, story: null })
    expect(((await call('GET', `/issues/${story.id}`)).body as Issue).progress).toEqual(story.progress)
  })

  test('filter epic/story: derived ids OR `none`; type accepts epic and story; parent stays the direct parent', async () => {
    const issues = await byNumber()
    const epic = issues.get(31)!
    const story = issues.get(33)!
    const inEpic = (await list(`${filterQuery({ epic: [epic.id] })}&limit=200`)).items
    expect(inEpic.length).toBeGreaterThan(2)
    expect(inEpic.every((issue) => issue.epic?.id === epic.id)).toBe(true)
    expect(inEpic.map((issue) => issue.number)).toContain(33)
    expect((await list(`${filterQuery({ story: [story.id] })}&limit=200`)).items.every((issue) => issue.story?.id === story.id)).toBe(true)
    const noEpic = (await list(`${filterQuery({ epic: ['none'] })}&limit=200`)).items
    expect(noEpic.map((issue) => issue.number).sort((a, b) => a - b)).toEqual([5, 10, 15, 20, 25, 30, 31, 32, 37, 38, 39, 40, 41, 42])
    expect((await list(`${filterQuery({ epic: [epic.id, 'none'] })}&limit=200`)).items).toHaveLength(inEpic.length + noEpic.length)
    expect((await list(filterQuery({ type: ['epic', 'story'] }))).items).toHaveLength(6)
    expect((await list(filterQuery({ parent: epic.id }))).items.map((issue) => issue.number).sort()).toEqual([33, 34])
  })

  test('hierarchy: an epic has no parent, a story only an epic; a work item anything; 400 invalid with the parentId or type path', async () => {
    const issues = await byNumber()
    const [epic, otherEpic, story, task] = [issues.get(31)!, issues.get(32)!, issues.get(33)!, issues.get(3)!]
    const refused = async (method: string, path: string, body: object, field: string) => {
      const response = await call(method, path, body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(response.body).toMatchObject({ error: 'invalid', issues: [{ path: field }] })
    }
    await refused('POST', '/issues', { title: 'x', type: 'epic', parentId: otherEpic.id }, 'parentId')
    await refused('POST', '/issues', { title: 'x', type: 'story', parentId: story.id }, 'parentId')
    await refused('POST', '/issues', { title: 'x', type: 'story', parentId: task.id }, 'parentId')
    expect((await call('POST', '/issues', { title: 'New story', type: 'story', parentId: epic.id })).body).toMatchObject({ type: 'story', epic: { id: epic.id }, progress: { total: 0, completed: 0 } })
    expect((await call('POST', '/issues', { title: 'New epic', type: 'epic' })).body).toMatchObject({ type: 'epic', parent: null, progress: { total: 0, completed: 0 } })
    for (const parent of [epic, story, task]) expect((await call('POST', '/issues', { title: 'Work', type: 'feature', parentId: parent.id })).status).toBe(201)

    await refused('PATCH', `/issues/${otherEpic.id}`, { parentId: epic.id }, 'parentId')
    await refused('PATCH', `/issues/${story.id}`, { parentId: issues.get(34)!.id }, 'parentId')
    // Type changes check the current parent (path `type`) and every direct child against the new type.
    await refused('PATCH', `/issues/${story.id}`, { type: 'epic' }, 'type')
    await refused('PATCH', `/issues/${epic.id}`, { type: 'story' }, 'type')
    await refused('PATCH', `/issues/${task.id}`, { type: 'story' }, 'type')
    const moved = await call('PATCH', `/issues/${story.id}`, { parentId: otherEpic.id })
    expect(moved.body).toMatchObject({ parent: { id: otherEpic.id }, epic: { id: otherEpic.id } })
    // The story's work items (APT-4 sits under stories[0]) follow it without any write of their own.
    expect(((await call('GET', '/issues/APT-4')).body as Issue).epic?.id).toBe(otherEpic.id)
    const timeline = (await call('GET', `/issues/${story.id}/timeline`)).body.items as TimelineItem[]
    expect(timeline.flatMap((item) => (item.kind === 'activity' ? [item.activity.field] : []))).toEqual(['created', 'parent'])
    // Leaving the epic and becoming one at once is fine: both directions are checked against the new state.
    expect((await call('PATCH', `/issues/${story.id}`, { parentId: null, type: 'epic' })).body).toMatchObject({ type: 'epic', parent: null, epic: null })
  })

  test('views: groupBy defaults to none, is saved and updated; unknown values are 400 invalid', async () => {
    const created = await call('POST', '/views', { name: 'Stories', layout: 'list', groupBy: 'story' })
    expect(created.body).toMatchObject({ groupBy: 'story', layout: 'list' })
    expect((await call('POST', '/views', { name: 'Plain' })).body.groupBy).toBe('none')
    expect((await call('PATCH', `/views/${created.body.id}`, { groupBy: 'epic' })).body.groupBy).toBe('epic')
    for (const bad of [{ name: 'x', groupBy: 'project' }, { name: 'x', groupBy: null }]) {
      const response = await call('POST', '/views', bad)
      expect(response.status).toBe(400)
      expect(response.body.issues[0].path).toBe('groupBy')
    }
    expect((await call('PATCH', `/views/${created.body.id}`, { groupBy: 'label' })).status).toBe(400)
  })
})

describe('tracker mock: comments, attachments, timeline', () => {
  test('comments merge into the timeline; authors edit, authors or Admins delete', async () => {
    const issue = (await call('GET', '/issues/APT-6')).body as Issue
    expect((await call('POST', `/issues/${issue.id}/comments`, { body: ' ' })).status).toBe(400)
    const comment = await call('POST', `/issues/${issue.id}/comments`, { body: '再現しました' })
    expect(comment.status).toBe(201)
    expect(comment.body).toMatchObject({ author: MOCK_PEOPLE.alex, body: '再現しました', editedAt: null })
    const items = (await call('GET', `/issues/${issue.id}/timeline`)).body.items as TimelineItem[]
    expect(items.map((item) => item.kind)).toEqual(['activity', 'comment'])
    expect((await call('GET', '/issues/APT-6')).body.commentCount).toBe(1)
    await as('dev-sam')
    expect((await call('PATCH', `/comments/${comment.body.id}`, { body: 'x' })).status).toBe(403)
    expect((await call('DELETE', `/comments/${comment.body.id}`)).status).toBe(403)
    await as('dev-alex', 'Admin')
    expect((await call('PATCH', `/comments/${comment.body.id}`, { body: '更新' })).body.editedAt).toEqual(expect.any(String))
    expect((await call('DELETE', `/comments/${comment.body.id}`)).status).toBe(204)
    expect((await call('GET', '/issues/APT-6')).body.commentCount).toBe(0)
  })

  test('attachments: multipart upload within limits, inline bytes, removal recorded in the timeline', async () => {
    const issue = (await call('GET', '/issues/APT-7')).body as Issue
    const form = new FormData()
    form.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }))
    const uploaded = await call('POST', `/issues/${issue.id}/attachments`, form)
    expect(uploaded.status).toBe(201)
    const attachment = uploaded.body as Attachment
    expect(attachment).toMatchObject({ filename: 'shot.png', mediaType: 'image/png', size: 4, url: `${BASE}/attachments/${attachment.id}`, uploader: MOCK_PEOPLE.alex })
    const bytes = await call('GET', `/attachments/${attachment.id}`)
    expect(bytes.headers.get('Content-Type')).toBe('image/png')
    expect(bytes.headers.get('Content-Disposition')).toBe('inline; filename="shot.png"')
    expect(bytes.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable')
    expect(new Uint8Array(bytes.body as ArrayBuffer)).toEqual(new Uint8Array([137, 80, 78, 71]))
    expect((await call('GET', '/issues/APT-7')).body.attachmentCount).toBe(1)

    const gif = new FormData()
    gif.append('file', new File(['GIF89a'], 'a.gif', { type: 'image/gif' }))
    expect((await call('POST', `/issues/${issue.id}/attachments`, gif)).status).toBe(400)
    const big = new FormData()
    big.append('file', new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }))
    expect((await call('POST', `/issues/${issue.id}/attachments`, big)).status).toBe(400)

    await as('dev-sam')
    expect((await call('DELETE', `/attachments/${attachment.id}`)).status).toBe(403)
    await as('dev-alex')
    expect((await call('DELETE', `/attachments/${attachment.id}`)).status).toBe(204)
    expect((await call('GET', `/attachments/${attachment.id}`)).status).toBe(404)
    const items = (await call('GET', `/issues/${issue.id}/timeline`)).body.items as TimelineItem[]
    const attachmentEvents = items.flatMap((item) => (item.kind === 'activity' && item.activity.field === 'attachment' ? [item.activity] : []))
    expect(attachmentEvents.map((activity) => [activity.from === null, activity.to === null])).toEqual([
      [true, false],
      [false, true],
    ])
  })
})

describe('tracker mock: projects', () => {
  test('fixture: three projects by name; issue n has none when n%3==0, else [Dashboard, Platform API, Builder Console][(n%3 + n%2) % 3]', async () => {
    const items = await projects()
    expect(items.map((project) => [project.name, project.color, project.archived, project.issueCount])).toEqual([
      ['Builder Console', 'orange', false, 10],
      ['Dashboard', 'blue', false, 5],
      // APT-41 and APT-42 (agents' reports) are in Platform API.
      ['Platform API', 'purple', false, 7],
    ])
    const byName = Object.fromEntries(items.map((project) => [project.name, project.id]))
    const order = [byName.Dashboard, byName['Platform API'], byName['Builder Console']]
    const all = (await list('?sort=number')).items
    for (const issue of all) {
      const seeded = issue.number <= 30
      const agentReport = issue.number === 41 || issue.number === 42
      expect(issue.projectId, issue.identifier).toBe(agentReport ? byName['Platform API']! : seeded && issue.number % 3 !== 0 ? order[((issue.number % 3) + (issue.number % 2)) % 3]! : null)
    }
    const closed = new Set((await statuses()).filter((status) => status.category === 'completed' || status.category === 'canceled').map((status) => status.id))
    for (const project of items) {
      expect(project.openIssueCount, project.name).toBe(all.filter((issue) => issue.projectId === project.id && !closed.has(issue.statusId)).length)
    }
    expect((await call('GET', `/projects/${byName.Dashboard}`)).body).toMatchObject({ name: 'Dashboard', issueCount: 5 })
    expect((await call('GET', '/projects/nope')).status).toBe(404)
  })

  test('filter: project ids OR `none`', async () => {
    const dashboard = await projectNamed('Dashboard')
    expect((await list(filterQuery({ project: ['none'] }))).items).toHaveLength(20)
    expect((await list(filterQuery({ project: [dashboard.id] }))).items.every((issue) => issue.projectId === dashboard.id)).toBe(true)
    expect((await list(filterQuery({ project: [dashboard.id, 'none'] }))).items).toHaveLength(25)
    expect((await call('GET', `/issues${filterQuery({ project: 'none' })}`)).status).toBe(400)
  })

  test('create, rename, describe and recolor are open to everyone; names are unique; archiving is Admin only', async () => {
    await as('dev-sam')
    const created = await call('POST', '/projects', { name: '  Docs site  ', color: 'teal' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ name: 'Docs site', description: '', color: 'teal', archived: false, issueCount: 0, openIssueCount: 0 })
    expect((await call('POST', '/projects', { name: 'Docs site' })).status).toBe(409)
    expect((await call('POST', '/projects', { name: 'Defaults' })).body.color).toBe('gray')
    for (const bad of [{ name: ' ' }, { name: 'x'.repeat(61) }, { name: 'x', color: 'brown' }, { name: 'x', description: 'x'.repeat(4097) }, { name: 'x', archived: true }]) {
      expect((await call('POST', '/projects', bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400)
    }
    const id = created.body.id as string
    expect((await call('PATCH', `/projects/${id}`, { name: 'Docs', description: 'Public docs', color: 'green' })).body).toMatchObject({ name: 'Docs', description: 'Public docs', color: 'green' })
    expect((await call('PATCH', `/projects/${id}`, { name: 'Dashboard' })).status).toBe(409)
    expect((await call('PATCH', `/projects/${id}`, { archived: true })).status).toBe(403)
    await as('dev-alex', 'Admin')
    expect((await call('PATCH', `/projects/${id}`, { archived: true })).body.archived).toBe(true)
    expect((await projects()).map((project) => project.name)).not.toContain('Docs')
    expect((await projects('?includeArchived=true')).map((project) => project.name)).toContain('Docs')
    expect((await call('PATCH', `/projects/${id}`, { archived: false })).body.archived).toBe(false)
  })

  test('issues: unknown or archived project is 400, changes record a `project` activity, an unchanged archived project stays', async () => {
    const dashboard = await projectNamed('Dashboard')
    const api = await projectNamed('Platform API')
    expect((await call('POST', '/issues', { title: 'x', type: 'task', projectId: 'nope' })).body.issues[0].path).toBe('projectId')
    const created = await call('POST', '/issues', { title: 'Scoped', type: 'task', projectId: dashboard.id })
    expect(created.body.projectId).toBe(dashboard.id)
    expect((await call('POST', '/issues', { title: 'Unscoped', type: 'task' })).body.projectId).toBeNull()
    expect((await projectNamed('Dashboard')).issueCount).toBe(6)

    const id = created.body.id as string
    expect((await call('PATCH', `/issues/${id}`, { projectId: api.id })).body.projectId).toBe(api.id)
    expect((await call('PATCH', `/issues/${id}`, { projectId: null })).body.projectId).toBeNull()
    const timeline = (await call('GET', `/issues/${id}/timeline`)).body.items as TimelineItem[]
    const moves = timeline.flatMap((item) => (item.kind === 'activity' && item.activity.field === 'project' ? [[item.activity.from, item.activity.to]] : []))
    expect(moves).toEqual([
      [dashboard.id, api.id],
      [api.id, null],
    ])

    await call('PATCH', `/issues/${id}`, { projectId: dashboard.id })
    await call('PATCH', `/projects/${dashboard.id}`, { archived: true })
    expect((await call('PATCH', `/issues/${id}`, { title: 'Still scoped' })).body).toMatchObject({ title: 'Still scoped', projectId: dashboard.id })
    expect((await call('PATCH', `/issues/${id}`, { projectId: dashboard.id })).status).toBe(200)
    const other = (await call('GET', '/issues/APT-3')).body as Issue
    const refused = await call('PATCH', `/issues/${other.id}`, { projectId: dashboard.id })
    expect(refused.status).toBe(400)
    expect(refused.body.issues[0]).toEqual({ path: 'projectId', message: 'project is archived' })
    expect((await call('POST', '/issues', { title: 'x', type: 'task', projectId: dashboard.id })).status).toBe(400)
  })

  test('delete is Admin only and refused while issues reference the project', async () => {
    const created = (await call('POST', '/projects', { name: 'Temporary' })).body as Project
    const issue = (await call('POST', '/issues', { title: 'In temporary', type: 'task', projectId: created.id })).body as Issue
    await as('dev-sam')
    expect((await call('DELETE', `/projects/${created.id}`)).status).toBe(403)
    await as('dev-alex', 'Admin')
    expect((await call('DELETE', `/projects/${created.id}`)).status).toBe(409)
    await call('PATCH', `/issues/${issue.id}`, { projectId: null })
    expect((await call('DELETE', `/projects/${created.id}`)).status).toBe(204)
    expect((await call('GET', `/projects/${created.id}`)).status).toBe(404)
  })

  test('a workspace without projects (reset with projects: none) has no project on any issue', async () => {
    await call('POST', '/__mock/reset', { projects: 'none' })
    expect(await projects('?includeArchived=true')).toEqual([])
    expect((await list()).items.every((issue) => issue.projectId === null)).toBe(true)
  })
})

describe('tracker mock: views and settings authorization', () => {
  test('views: shared ∪ mine; sharing and editing shared views is Admin only', async () => {
    await as('dev-sam')
    expect((await call('POST', '/views', { name: 'Team', shared: true })).status).toBe(403)
    const mine = await call('POST', '/views', { name: 'Sam bugs', layout: 'board', filter: { type: ['bug'], assignee: ['me'] }, sort: 'priority' })
    expect(mine.status).toBe(201)
    expect(mine.body).toMatchObject({ owner: MOCK_PEOPLE.sam, shared: false, layout: 'board', sort: 'priority' })
    expect(((await call('GET', '/views')).body.items as View[]).map((view) => view.name)).toEqual(['Bugs', 'My issues', 'By epic', 'Sam bugs'])
    const bugs = ((await call('GET', '/views')).body.items as View[])[0]!
    expect((await call('PATCH', `/views/${bugs.id}`, { name: 'x' })).status).toBe(403)
    expect((await call('PATCH', `/views/${mine.body.id}`, { name: 'Sam: bugs' })).body.name).toBe('Sam: bugs')
    expect((await call('POST', '/views', { name: 'bad', filter: { nope: [] } })).status).toBe(400)
    await as('dev-jordan')
    expect(((await call('GET', '/views')).body.items as View[]).map((view) => view.name)).toEqual(['Bugs', 'My issues', 'By epic'])
    expect((await call('DELETE', `/views/${mine.body.id}`)).status).toBe(404)
    await as('dev-alex', 'Admin')
    expect((await call('PATCH', `/views/${bugs.id}`, { filter: { type: ['bug'], environment: ['craftsman'] } })).body.filter).toEqual({ type: ['bug'], environment: ['craftsman'] })
  })

  test('statuses: Admin writes, appended in category, delete guarded, order keeps categories grouped', async () => {
    await as('dev-sam')
    expect((await call('POST', '/statuses', { name: 'QA', category: 'started' })).status).toBe(403)
    await as('dev-alex', 'Admin')
    const qa = await call('POST', '/statuses', { name: 'QA', category: 'started', color: 'purple' })
    expect(qa.status).toBe(201)
    expect((await statuses()).map((status) => status.name)).toEqual(['Backlog', 'Todo', 'In Progress', 'In Review', 'QA', 'Done', 'Canceled'])
    expect((await call('PATCH', `/statuses/${qa.body.id}`, { category: 'completed' })).status).toBe(400)
    expect((await call('PATCH', `/statuses/${qa.body.id}`, { name: 'Verify' })).body.name).toBe('Verify')
    expect((await call('DELETE', `/statuses/${(await statusNamed('Todo')).id}`)).status).toBe(409)
    expect((await call('DELETE', `/statuses/${qa.body.id}`)).status).toBe(204)
    const ids = (await statuses()).map((status) => status.id)
    expect((await call('PUT', '/statuses/order', { ids: [ids[1], ids[0], ...ids.slice(2)] })).status).toBe(400)
    const swapped = await call('PUT', '/statuses/order', { ids: [ids[0], ids[1], ids[3], ids[2], ids[4], ids[5]] })
    expect((swapped.body.items as Status[]).map((status) => status.name)).toEqual(['Backlog', 'Todo', 'In Review', 'In Progress', 'Done', 'Canceled'])
  })

  test('labels and workspace: Admin writes; a new key renames identifiers', async () => {
    const created = await call('POST', '/labels', { name: 'security', color: 'orange' })
    expect(created.status).toBe(201)
    expect((await call('POST', '/labels', { name: 'Security', color: 'red' })).status).toBe(409)
    expect((await call('POST', '/labels', { name: 'x', color: 'brown' })).status).toBe(400)
    expect((await call('PATCH', `/labels/${created.body.id}`, { color: 'pink' })).body.color).toBe('pink')
    expect((await call('DELETE', `/labels/${created.body.id}`)).status).toBe(204)
    expect((await call('PATCH', '/workspace', { key: 'apt' })).status).toBe(400)
    expect((await call('PATCH', '/workspace', { key: 'BUG', name: 'AppThrust bugs' })).body).toMatchObject({ key: 'BUG', name: 'AppThrust bugs' })
    expect((await call('GET', '/issues/BUG-3')).body.identifier).toBe('BUG-3')
    await as('dev-sam')
    expect((await call('PATCH', '/workspace', { name: 'x' })).status).toBe(403)
    expect((await call('PATCH', `/labels/${(await call('GET', '/labels')).body.items[0].id}`, { name: 'x' })).status).toBe(403)
  })

  test('openapi.json is served without the caller', async () => {
    const { status, body } = await call('GET', '/openapi.json')
    expect(status).toBe(200)
    expect(body.openapi).toMatch(/^3\.1/)
  })
})

describe('tracker mock: sprints fixture (API.md v0.1.10)', () => {
  const today = () => dayInZone(Date.now(), 'Asia/Tokyo')
  const sprints = async (query = '') => (await call('GET', `/sprints${query}`)).body.items as Sprint[]
  const byNumber = async () => new Map((await sprints()).map((sprint) => [sprint.number, sprint]))
  const issueNumbered = async (n: number) => (await call('GET', `/issues/APT-${n}`)).body as Issue
  const members = async (sprintId: string) => (await list(`${filterQuery({ sprint: [sprintId] })}&sort=number&limit=200`)).items.map((issue) => issue.number)

  test('three closed one-week sprints, an active two-week sprint on its fourth day, a planned one; API order', async () => {
    const items = await sprints()
    expect(items.map((sprint) => [sprint.number, sprint.state, sprint.lengthWeeks])).toEqual([
      [4, 'active', 2],
      [5, 'planned', 1],
      [3, 'closed', 1],
      [2, 'closed', 1],
      [1, 'closed', 1],
    ])
    const sprint = await byNumber()
    expect(sprint.get(4)).toMatchObject({ name: 'Sprint 4', goal: 'Sprint planning and burndown', startsOn: addDays(today(), -3), endsOn: addDays(today(), 10), closedAt: null })
    expect(sprint.get(5)).toMatchObject({ startsOn: addDays(today(), 11), endsOn: addDays(today(), 17), startedAt: null, commitment: null, current: { scopePoints: 4, scopeIssues: 3, donePoints: 0, doneIssues: 0 } })
    expect(sprint.get(1)).toMatchObject({ startsOn: addDays(today(), -24), endsOn: addDays(today(), -18) })
    expect([1, 2, 3, 4].map((n) => [sprint.get(n)!.commitment, sprint.get(n)!.current])).toEqual([
      [
        { scopePoints: 21, scopeIssues: 4, donePoints: 0, doneIssues: 0 },
        { scopePoints: 21, scopeIssues: 4, donePoints: 18, doneIssues: 3 },
      ],
      [
        { scopePoints: 24, scopeIssues: 4, donePoints: 0, doneIssues: 0 },
        { scopePoints: 24, scopeIssues: 4, donePoints: 21, doneIssues: 3 },
      ],
      [
        { scopePoints: 27, scopeIssues: 4, donePoints: 0, doneIssues: 0 },
        { scopePoints: 27, scopeIssues: 4, donePoints: 24, doneIssues: 3 },
      ],
      [
        { scopePoints: 10, scopeIssues: 6, donePoints: 0, doneIssues: 0 },
        { scopePoints: 10, scopeIssues: 6, donePoints: 0, doneIssues: 0 },
      ],
    ])
    expect(await members(sprint.get(1)!.id)).toEqual([5, 11, 17])
    expect(await members(sprint.get(2)!.id)).toEqual([23, 29, 37])
    expect(await members(sprint.get(3)!.id)).toEqual([38, 39, 40])
    expect(await members(sprint.get(4)!.id)).toEqual([2, 3, 4, 10, 15, 30, 34])
    expect(await members(sprint.get(5)!.id)).toEqual([8, 14, 26])
    expect((await issueNumbered(5)).sprint).toEqual({ id: sprint.get(1)!.id, number: 1, name: 'Sprint 1', state: 'closed' })
  })

  test('four Done work items close the seed, and 17 work items carry a size across all five', async () => {
    const all = (await list('?sort=number&limit=200')).items
    const done = await statusNamed('Done')
    expect(all.slice(36, 40).map((issue) => [issue.number, issue.title, issue.type, issue.statusId === done.id, issue.parent, issue.projectId, issue.estimate])).toEqual([
      [37, 'Speed up issue search', 'task', true, null, null, 'L'],
      [38, 'Add bulk status change', 'feature', true, null, null, 'XL'],
      [39, 'Tidy up the settings layout', 'task', true, null, null, 'XL'],
      [40, 'Show issue counts per project', 'feature', true, null, null, 'XL'],
    ])
    const sized = all.filter((issue) => issue.estimate !== null)
    expect(sized.map((issue) => `${issue.number}:${issue.estimate}`)).toEqual(['2:M', '3:S', '4:M', '5:XL', '8:XS', '10:S', '11:L', '14:M', '16:XS', '17:L', '23:XL', '29:XL', '30:S', '37:L', '38:XL', '39:XL', '40:XL'])
    expect(all.filter((issue) => issue.type === 'epic').every((issue) => issue.estimate === null && issue.sprint === null)).toBe(true)
  })

  test('velocity: 18, 21, 24 points (committed 21, 24, 27), 21 per week; 3 issues each in the issue unit', async () => {
    const points = (await call('GET', '/velocity')).body as Velocity
    expect(points.unit).toBe('points')
    expect(points.items.map((item) => [item.sprint.number, item.lengthWeeks, item.committed, item.completed])).toEqual([
      [1, 1, 21, 18],
      [2, 1, 24, 21],
      [3, 1, 27, 24],
    ])
    expect(points.averagePerWeek).toBe(21)
    const issues = (await call('GET', '/velocity?unit=issues')).body as Velocity
    expect(issues.items.map((item) => [item.committed, item.completed])).toEqual([
      [4, 3],
      [4, 3],
      [4, 3],
    ])
    expect(issues.averagePerWeek).toBe(3)
    expect(((await call('GET', '/velocity?limit=2')).body as Velocity).items.map((item) => item.sprint.number)).toEqual([2, 3])
    for (const bad of ['?limit=0', '?limit=27', '?unit=hours']) expect((await call('GET', `/velocity${bad}`)).status, bad).toBe(400)
  })

  test('burndown of the active sprint: commitment on day one, the scope increase on day two, the cancellation on day three, nothing after today', async () => {
    const active = (await byNumber()).get(4)!
    const burndown = (await call('GET', `/sprints/${active.id}/burndown?unit=points`)).body as Burndown
    expect(burndown).toMatchObject({ sprint: { id: active.id, state: 'active' }, unit: 'points', today: today() })
    expect(burndown.points).toHaveLength(14)
    expect(burndown.points.slice(0, 4).map((point) => [point.day, point.scope, point.done, point.remaining])).toEqual([
      [addDays(today(), -3), 10, 0, 10],
      [addDays(today(), -2), 12, 0, 12],
      [addDays(today(), -1), 10, 0, 10],
      [today(), 10, 0, 10],
    ])
    expect(burndown.points[0]!.ideal).toBe(10)
    expect(burndown.points[13]!.ideal).toBe(0)
    expect(burndown.points.slice(4).every((point) => point.remaining === undefined && point.scope === undefined && typeof point.ideal === 'number')).toBe(true)
    const issues = (await call('GET', `/sprints/${active.id}/burndown?unit=issues`)).body as Burndown
    expect(issues.points.slice(0, 4).map((point) => point.scope)).toEqual([6, 7, 6, 6])
    // A closed sprint's last day carries its final tally.
    const first = (await byNumber()).get(1)!
    const closed = (await call('GET', `/sprints/${first.id}/burndown`)).body as Burndown
    expect(closed.points[6]).toMatchObject({ scope: 21, done: 18, remaining: 3 })
    expect((await call('GET', `/sprints/${active.id}/burndown?unit=hours`)).status).toBe(400)
    expect((await call('GET', '/sprints/nope/burndown')).status).toBe(404)
    // `project` restricts to issues currently in that project.
    const none = (await call('GET', `/sprints/${active.id}/burndown?project=none`)).body as Burndown
    // APT-3 (S), APT-15, APT-30 (canceled on day three) and APT-34 have no project.
    expect(none.points[3]).toMatchObject({ scope: 2, remaining: 2 })
  })
})

describe('tracker mock: estimates and membership on issue writes', () => {
  const sprintsByNumber = async () => new Map(((await call('GET', '/sprints')).body.items as Sprint[]).map((sprint) => [sprint.number, sprint]))
  const issueNumbered = async (n: number) => (await call('GET', `/issues/APT-${n}`)).body as Issue
  const refused = async (method: string, path: string, body: object, field: string) => {
    const response = await call(method, path, body)
    expect(response.status, JSON.stringify(body)).toBe(400)
    expect(response.body).toMatchObject({ error: 'invalid', issues: [{ path: field }] })
  }

  test('estimating, completing, moving and deleting write the ledger; the burndown moves', async () => {
    const sprint = await sprintsByNumber()
    const active = sprint.get(4)!
    const planned = sprint.get(5)!
    const fifteen = await issueNumbered(15)
    expect((await call('PATCH', `/issues/${fifteen.id}`, { estimate: 'L' })).body).toMatchObject({ estimate: 'L' })
    expect((await call('GET', `/sprints/${active.id}`)).body.current).toEqual({ scopePoints: 15, scopeIssues: 6, donePoints: 0, doneIssues: 0 })
    const done = await statusNamed('Done')
    await call('PATCH', `/issues/${fifteen.id}`, { statusId: done.id })
    expect((await call('GET', `/sprints/${active.id}`)).body.current).toEqual({ scopePoints: 15, scopeIssues: 6, donePoints: 5, doneIssues: 1 })
    const burndown = (await call('GET', `/sprints/${active.id}/burndown`)).body as Burndown
    expect(burndown.points[3]).toMatchObject({ scope: 15, done: 5, remaining: 10 })
    // Commitment stays the ledger at the start.
    expect((await call('GET', `/sprints/${active.id}`)).body.commitment).toEqual({ scopePoints: 10, scopeIssues: 6, donePoints: 0, doneIssues: 0 })

    const two = await issueNumbered(2)
    expect((await call('PATCH', `/issues/${two.id}`, { sprintId: planned.id })).body.sprint).toEqual({ id: planned.id, number: 5, name: 'Sprint 5', state: 'planned' })
    expect((await call('GET', `/sprints/${active.id}`)).body.current.scopePoints).toBe(12)
    expect((await call('GET', `/sprints/${planned.id}`)).body.current).toMatchObject({ scopePoints: 7, scopeIssues: 4 })
    await call('PATCH', `/issues/${two.id}`, { sprintId: null })
    expect((await call('GET', `/sprints/${planned.id}`)).body.current.scopePoints).toBe(4)
    const timeline = (await call('GET', `/issues/${two.id}/timeline`)).body.items as TimelineItem[]
    expect(timeline.flatMap((item) => (item.kind === 'activity' && item.activity.field === 'sprint' ? [[(item.activity.from as { number?: number } | null)?.number ?? null, (item.activity.to as { number?: number } | null)?.number ?? null]] : []))).toEqual([
      [4, 5],
      [5, null],
    ])
    const fifteenTimeline = (await call('GET', `/issues/${fifteen.id}/timeline`)).body.items as TimelineItem[]
    expect(fifteenTimeline.find((item) => item.kind === 'activity' && item.activity.field === 'estimate')).toMatchObject({ activity: { from: null, to: 'L' } })

    const three = await issueNumbered(3)
    await call('DELETE', `/issues/${three.id}`)
    expect((await call('GET', `/sprints/${active.id}`)).body.current).toEqual({ scopePoints: 10, scopeIssues: 4, donePoints: 5, doneIssues: 1 })
    // A new issue may join with its size.
    const created = (await call('POST', '/issues', { title: 'Planned work', type: 'task', estimate: 'M', sprintId: planned.id })).body as Issue
    expect(created).toMatchObject({ estimate: 'M', sprint: { id: planned.id } })
    expect((await call('GET', `/sprints/${planned.id}`)).body.current.scopePoints).toBe(7)
    // Edits of a closed sprint's member write nothing to it.
    const five = await issueNumbered(5)
    await call('PATCH', `/issues/${five.id}`, { estimate: 'XS' })
    expect((await call('GET', `/sprints/${sprint.get(1)!.id}`)).body.current.donePoints).toBe(18)
  })

  test('refusals: sizes, epics, unknown or closed sprints, frozen members, lineage, re-checks on type and parent changes', async () => {
    const sprint = await sprintsByNumber()
    const active = sprint.get(4)!
    const closed = sprint.get(1)!
    const [epic, nine, ten, fifteen, five, story34] = await Promise.all([31, 9, 10, 15, 5, 34].map(issueNumbered))
    await refused('PATCH', `/issues/${nine.id}`, { estimate: 'XXL' }, 'estimate')
    await refused('PATCH', `/issues/${epic!.id}`, { estimate: 'S' }, 'estimate')
    await refused('PATCH', `/issues/${epic!.id}`, { sprintId: active.id }, 'sprintId')
    await refused('PATCH', `/issues/${nine.id}`, { sprintId: 'nope' }, 'sprintId')
    await refused('PATCH', `/issues/${nine.id}`, { sprintId: closed.id }, 'sprintId')
    await refused('POST', '/issues', { title: 'x', type: 'task', sprintId: closed.id }, 'sprintId')
    await refused('POST', '/issues', { title: 'x', type: 'epic', estimate: 'M' }, 'estimate')
    // APT-9 sits under APT-34, which is in the active sprint.
    expect(nine.parent?.id).toBe(story34!.id)
    await refused('PATCH', `/issues/${nine.id}`, { sprintId: active.id }, 'sprintId')
    await refused('POST', '/issues', { title: 'x', type: 'task', parentId: story34!.id, sprintId: active.id }, 'sprintId')
    // A closed sprint's member is frozen, even to the backlog.
    await refused('PATCH', `/issues/${five.id}`, { sprintId: active.id }, 'sprintId')
    await refused('PATCH', `/issues/${five.id}`, { sprintId: null }, 'sprintId')
    // Type and parent changes re-check membership.
    await refused('PATCH', `/issues/${fifteen.id}`, { type: 'epic' }, 'sprintId')
    await refused('PATCH', `/issues/${ten.id}`, { parentId: story34!.id }, 'sprintId')
    await refused('PATCH', `/issues/${ten.id}`, { type: 'epic' }, 'estimate')
    expect((await call('PATCH', `/issues/${ten.id}`, { type: 'epic', estimate: null, sprintId: null })).body).toMatchObject({ type: 'epic', estimate: null, sprint: null })
  })

  test('filter by sprint (ids, active, none) and sort by estimate', async () => {
    const sprint = await sprintsByNumber()
    const active = (await list(`${filterQuery({ sprint: ['active'] })}&sort=number`)).items.map((issue) => issue.number)
    expect(active).toEqual([2, 3, 4, 10, 15, 30, 34])
    const both = (await list(`${filterQuery({ sprint: [sprint.get(5)!.id, 'active'] })}&limit=200`)).items
    expect(both).toHaveLength(10)
    const backlog = (await list(`${filterQuery({ sprint: ['none'] })}&limit=200`)).items
    expect(backlog.every((issue) => issue.sprint === null)).toBe(true)
    expect(backlog).toHaveLength(42 - 3 * 3 - 7 - 3)
    expect((await call('GET', `/issues${filterQuery({ sprint: ['Sprint 4'] })}`)).status).toBe(400)
    const bySize = (await list('?sort=estimate&limit=200')).items
    expect(bySize.slice(0, 6).every((issue) => issue.estimate === 'XL')).toBe(true)
    expect(bySize.at(-1)!.estimate).toBeNull()
    expect((await call('POST', '/views', { name: 'By sprint', groupBy: 'sprint', sort: 'estimate', filter: { sprint: ['active'] } })).body).toMatchObject({ groupBy: 'sprint', sort: 'estimate' })
  })
})

describe('tracker mock: sprint lifecycle', () => {
  const sprintsByNumber = async () => new Map(((await call('GET', '/sprints')).body.items as Sprint[]).map((sprint) => [sprint.number, sprint]))
  const today = () => dayInZone(Date.now(), 'Asia/Tokyo')

  test('create: defaults (workspace length, after the last open sprint, "Sprint <n>"), validation and overlap', async () => {
    const created = await call('POST', '/sprints', {})
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ number: 6, name: 'Sprint 6', goal: '', state: 'planned', lengthWeeks: 1, startsOn: addDays(today(), 18), endsOn: addDays(today(), 24), current: { scopePoints: 0 }, commitment: null })
    expect((await call('POST', '/sprints', { name: '  Hardening  ', goal: 'Fix what we broke', lengthWeeks: 2 })).body).toMatchObject({ number: 7, name: 'Hardening', lengthWeeks: 2, startsOn: addDays(today(), 25), endsOn: addDays(today(), 38) })
    expect((await call('POST', '/sprints', { startsOn: addDays(today(), 20) })).status).toBe(409)
    for (const bad of [{ lengthWeeks: 3 }, { name: 'x'.repeat(61) }, { name: ' ' }, { startsOn: '2026-13-01' }, { goal: 'x'.repeat(4097) }, { colour: 'red' }]) {
      expect((await call('POST', '/sprints', bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400)
    }
    expect((await call('GET', '/sprints?state=planned')).body.items.map((sprint: Sprint) => sprint.number)).toEqual([5, 6, 7])
    expect((await call('GET', '/sprints?state=paused')).status).toBe(400)
    expect((await call('GET', '/sprints/nope')).status).toBe(404)
  })

  test('patch: names and goals any time; dates only while planned and without overlap', async () => {
    const sprint = await sprintsByNumber()
    const active = sprint.get(4)!
    const planned = sprint.get(5)!
    expect((await call('PATCH', `/sprints/${active.id}`, { name: 'Sprint 4: planning', goal: 'Ship it' })).body).toMatchObject({ name: 'Sprint 4: planning', goal: 'Ship it' })
    expect((await call('PATCH', `/sprints/${active.id}`, { lengthWeeks: 1 })).status).toBe(409)
    expect((await call('PATCH', `/sprints/${planned.id}`, { lengthWeeks: 2 })).body).toMatchObject({ lengthWeeks: 2, endsOn: addDays(today(), 24) })
    expect((await call('PATCH', `/sprints/${planned.id}`, { startsOn: addDays(today(), 5) })).status).toBe(409)
  })

  test('start: 409 while another sprint is active or when not planned', async () => {
    const sprint = await sprintsByNumber()
    expect((await call('POST', `/sprints/${sprint.get(5)!.id}/start`)).status).toBe(409)
    expect((await call('POST', `/sprints/${sprint.get(4)!.id}/start`)).status).toBe(409)
    expect((await call('POST', `/sprints/${sprint.get(1)!.id}/start`)).status).toBe(409)
  })

  test('close: counts stay on the closed sprint, unfinished scope moves to the target, velocity gains a bar; then the next sprint starts today', async () => {
    const sprint = await sprintsByNumber()
    const active = sprint.get(4)!
    const planned = sprint.get(5)!
    expect((await call('POST', `/sprints/${planned.id}/close`, { moveIncompleteTo: null })).status).toBe(409)
    expect((await call('POST', `/sprints/${active.id}/close`, {})).status).toBe(400)
    expect((await call('POST', `/sprints/${active.id}/close`, { moveIncompleteTo: sprint.get(1)!.id })).body.issues[0].path).toBe('moveIncompleteTo')
    // Complete one issue first: it stays in the closing sprint and counts as velocity.
    const four = (await call('GET', '/issues/APT-4')).body as Issue
    await call('PATCH', `/issues/${four.id}`, { statusId: (await statusNamed('Done')).id })
    const closed = await call('POST', `/sprints/${active.id}/close`, { moveIncompleteTo: planned.id })
    expect(closed.status).toBe(200)
    expect(closed.body).toMatchObject({ state: 'closed', closedAt: expect.any(String), current: { scopePoints: 10, scopeIssues: 6, donePoints: 3, doneIssues: 1 } })
    const membersOf = async (id: string) => (await list(`${filterQuery({ sprint: [id] })}&sort=number&limit=200`)).items.map((issue) => issue.number)
    expect(await membersOf(active.id)).toEqual([4, 30])
    expect(await membersOf(planned.id)).toEqual([2, 3, 8, 10, 14, 15, 26, 34])
    expect((await call('GET', `/sprints/${planned.id}`)).body.current).toEqual({ scopePoints: 4 + 3 + 2 + 2, scopeIssues: 8, donePoints: 0, doneIssues: 0 })
    const velocity = (await call('GET', '/velocity')).body as Velocity
    expect(velocity.items.map((item) => [item.sprint.number, item.committed, item.completed])).toEqual([
      [1, 21, 18],
      [2, 24, 21],
      [3, 27, 24],
      [4, 10, 3],
    ])
    // The last three: 21, 24 and 3 over two weeks (1.5 a week).
    expect(velocity.averagePerWeek).toBe(15.5)
    // Writes after the close leave it alone.
    await call('PATCH', `/issues/${four.id}`, { estimate: 'XL' })
    expect((await call('GET', `/sprints/${active.id}`)).body.current.donePoints).toBe(3)

    const started = await call('POST', `/sprints/${planned.id}/start`)
    expect(started.body).toMatchObject({ state: 'active', startsOn: today(), endsOn: addDays(today(), 6), startedAt: expect.any(String) })
    expect(started.body.commitment).toEqual(started.body.current)
  })

  test('close sends an unfinished issue to the backlog when a relative is already in the target', async () => {
    const sprint = await sprintsByNumber()
    const [eight, story33, four] = await Promise.all(['APT-8', 'APT-33', 'APT-4'].map(async (key) => (await call('GET', `/issues/${key}`)).body as Issue))
    await call('PATCH', `/issues/${eight!.id}`, { sprintId: null })
    expect((await call('PATCH', `/issues/${story33!.id}`, { sprintId: sprint.get(5)!.id })).status).toBe(200)
    await call('POST', `/sprints/${sprint.get(4)!.id}/close`, { moveIncompleteTo: sprint.get(5)!.id })
    expect(((await call('GET', `/issues/${four!.id}`)).body as Issue).sprint).toBeNull()
    expect(((await call('GET', '/issues/APT-3')).body as Issue).sprint?.id).toBe(sprint.get(5)!.id)
  })

  test('delete: Admin only, planned only; members return to the backlog', async () => {
    const sprint = await sprintsByNumber()
    await as('dev-sam')
    expect((await call('DELETE', `/sprints/${sprint.get(5)!.id}`)).status).toBe(403)
    // Anyone else may create, start and close.
    expect((await call('POST', '/sprints', {})).status).toBe(201)
    await as('dev-alex', 'Admin')
    expect((await call('DELETE', `/sprints/${sprint.get(4)!.id}`)).status).toBe(409)
    expect((await call('DELETE', `/sprints/${sprint.get(5)!.id}`)).status).toBe(204)
    expect((await call('GET', `/sprints/${sprint.get(5)!.id}`)).status).toBe(404)
    expect(((await call('GET', '/issues/APT-8')).body as Issue).sprint).toBeNull()
  })

  test('workspace sprint settings: Admin sets length and timezone; new sprints take the length', async () => {
    expect((await call('PATCH', '/workspace', { sprintLengthWeeks: 3 })).status).toBe(400)
    expect((await call('PATCH', '/workspace', { timezone: 'Mars/Olympus' })).status).toBe(400)
    expect((await call('PATCH', '/workspace', { sprintLengthWeeks: 2, timezone: 'Europe/Berlin' })).body).toMatchObject({ sprintLengthWeeks: 2, timezone: 'Europe/Berlin' })
    expect((await call('POST', '/sprints', {})).body.lengthWeeks).toBe(2)
    await as('dev-sam')
    expect((await call('PATCH', '/workspace', { sprintLengthWeeks: 1 })).status).toBe(403)
  })
})

// --- agents (API.md "Agents"; fixture `.tmp/agents-ui/fixture.md`) -------------------------------------

/** A call made with the named agent's Access Key assertion. */
const agentCall = (handle: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => call(method, path, body, { 'X-Mock-Agent': handle, ...headers })
const issueNamed = async (identifier: string) => (await call('GET', `/issues/${identifier}`)).body as Issue
const agentsByHandle = async () => new Map(((await call('GET', '/agents?includeDisabled=true')).body.items as Agent[]).map((agent) => [agent.handle, agent]))
const inbox = async (handle?: string) => ((handle ? await agentCall(handle, 'GET', '/inbox') : await call('GET', '/inbox')).body.items as InboxItem[])
const inboxTitles = (items: InboxItem[]) => items.map((item) => (item.kind === 'mention' ? `mention ${item.issue.identifier}` : item.kind === 'assignment' ? `assignment ${item.issue.identifier}` : `${item.kind} ${item.request.title}`))
const MINUTE = 60_000

describe('tracker mock: agents fixture', () => {
  test('four agents (one disabled) with derived counts; disabled ones only on request', async () => {
    const active = (await call('GET', '/agents')).body.items as Agent[]
    expect(active.map((agent) => agent.handle)).toEqual(['astra', 'claude', 'opus-ui'])
    const all = await agentsByHandle()
    expect([...all.values()].map((agent) => [agent.handle, agent.name, agent.owner.sub, agent.disabled, agent.registeredByKey, agent.activeRuns, agent.openRequests])).toEqual([
      ['astra', 'Astra', 'dev-sam', false, null, 1, 1],
      ['claude', 'Claude', 'dev-jordan', false, null, 0, 1],
      ['legacy-bot', 'Legacy bot', 'dev-alex', true, null, 0, 0],
      ['opus-ui', 'Opus UI', 'dev-alex', false, 'ak-md8mw', 1, 1],
    ])
    expect(all.get('astra')!.lastSeenAt).toEqual(expect.any(String))
  })

  test('delegations, runs and request counts on the board', async () => {
    const astra = (await agentsByHandle()).get('astra')!
    const apt15 = await issueNamed('APT-15')
    expect(apt15.assignee).toMatchObject({ sub: `agent:${astra.id}`, kind: 'agent', name: 'Astra', agent: { handle: 'astra', owner: { sub: 'dev-sam' }, disabled: false } })
    // The wire carries `kind` on every person, the delegator included.
    const delegator: unknown = apt15.delegator
    expect(delegator).toEqual({ ...MOCK_PEOPLE.alex, kind: 'person' })
    expect(apt15.activeRun).toMatchObject({ state: 'running', session: 'astra · lane-2', agent: { name: 'Astra' } })
    expect((await issueNamed('APT-27')).activeRun?.state).toBe('waiting')
    expect((await issueNamed('APT-27')).openRequestCount).toBe(1)
    expect((await issueNamed('APT-9')).activeRun?.state).toBe('stalled')
    expect((await issueNamed('APT-16'))).toMatchObject({ activeRun: null, openRequestCount: 1 })
    expect((await issueNamed('APT-1')).openRequestCount).toBe(1)
    expect((await issueNamed('APT-41')).reporter).toMatchObject({ kind: 'agent', name: 'Claude' })
    expect((await issueNamed('APT-42'))).toMatchObject({ reporter: { name: 'Astra' }, assignee: { name: 'Astra' }, delegator: MOCK_PEOPLE.sam })
    const numbers = async (filter: object) => (await list(`${filterQuery(filter)}&sort=number&limit=200`)).items.map((issue) => issue.number)
    expect(await numbers({ run: ['active'] })).toEqual([15, 27])
    expect(await numbers({ run: ['stalled'] })).toEqual([9])
    expect(await numbers({ request: ['open'] })).toEqual([1, 16, 27])
    // `mine`: an open request the caller raised (Alex's only request, R6, is answered); astra raised the open review of APT-16.
    expect(await numbers({ request: ['mine'] })).toEqual([])
    expect((await agentCall('astra', 'GET', `/issues${filterQuery({ request: ['mine'] })}`)).body.items.map((issue: IssueSummary) => issue.number)).toEqual([16])
    expect(await numbers({ assigneeKind: ['agent'] })).toEqual([4, 9, 13, 15, 16, 19, 21, 26, 27, 42])
    expect(await numbers({ agent: [astra.id] })).toEqual([4, 9, 15, 16, 19, 42])
    for (const bad of [{ run: ['live'] }, { request: ['all'] }, { assigneeKind: ['bot'] }, { agent: ['astra'] }]) expect((await call('GET', `/issues${filterQuery(bad)}`)).status).toBe(400)
    // A run on the timeline sits at its start; requests at their creation.
    const kinds = ((await call('GET', `/issues/${apt15.id}/timeline`)).body.items as TimelineItem[]).map((item) => item.kind)
    expect(kinds).toEqual(['activity', 'activity', 'activity', 'run', 'request'])
  })

  test('inboxes: requests first, then answers and mentions; agents also get their actionable assignments', async () => {
    expect(inboxTitles(await inbox())).toEqual([
      'request Add APT-1 to the current sprint?',
      'request Review: CLI login expires too early',
      "request Which label should the panel's close button use?",
      'answer Which open bugs look like duplicates of APT-22?',
    ])
    await as('dev-sam')
    expect(inboxTitles(await inbox())).toEqual(['request Add APT-1 to the current sprint?'])
    // Assignments by priority (APT-42 medium; APT-4, APT-9, APT-19 low with APT-4 in the active sprint; APT-15 none), then number.
    expect(inboxTitles(await inbox('astra'))).toEqual(['mention APT-22', 'answer Review: Platform API returns stale status', 'assignment APT-42', 'assignment APT-4', 'assignment APT-9', 'assignment APT-19', 'assignment APT-15'])
    expect(inboxTitles(await inbox('opus-ui'))).toEqual(['assignment APT-26', 'assignment APT-13'])
    expect(inboxTitles(await inbox('claude'))).toEqual(['assignment APT-21'])
  })
})

describe('tracker mock: agent keys', () => {
  test('the handle is the key subject; scopes gate methods; agents act with role Viewer', async () => {
    expect(await agentCall('nobody', 'GET', '/me')).toMatchObject({ status: 403, body: { error: 'key_subject' } })
    expect(await agentCall('legacy-bot', 'GET', '/issues')).toMatchObject({ status: 403, body: { error: 'key_subject' } })
    const me = (await agentCall('astra', 'GET', '/me')).body
    expect(me).toMatchObject({ kind: 'agent', name: 'Astra', role: 'Viewer', isAdmin: false, scopes: ['tracker:read', 'tracker:write'], agent: { handle: 'astra' } })
    expect(await agentCall('astra', 'POST', '/issues', { title: 'x', type: 'task' }, { 'X-Mock-Scopes': 'tracker:read' })).toMatchObject({ status: 403, body: { error: 'insufficient_scope' } })
    expect(await agentCall('astra', 'GET', '/issues', undefined, { 'X-Mock-Scopes': 'tracker:write' })).toMatchObject({ status: 403, body: { error: 'insufficient_scope' } })
    expect((await agentCall('astra', 'GET', '/people')).body).toEqual({ items: [], source: 'unavailable' })
    expect((await agentCall('astra', 'POST', '/agents', { handle: 'x1', name: 'X', ownerSub: 'dev-alex' })).status).toBe(403)
    expect((await agentCall('astra', 'PATCH', '/workspace', { agentCompletion: 'direct' })).status).toBe(403)
  })

  test('agents edit fields only as assignee or reporter, assign only themselves on their reports, never complete under review', async () => {
    const done = await statusNamed('Done')
    const apt2 = await issueNamed('APT-2')
    expect((await agentCall('astra', 'PATCH', `/issues/${apt2.id}`, { priority: 'high' })).status).toBe(403)
    // Commenting and raising questions work on any issue.
    expect((await agentCall('astra', 'POST', `/issues/${apt2.id}/comments`, { body: 'Looks related to APT-15.' })).status).toBe(201)
    const apt19 = await issueNamed('APT-19')
    expect((await agentCall('astra', 'PATCH', `/issues/${apt19.id}`, { priority: 'high' })).body.priority).toBe('high')
    expect((await agentCall('astra', 'PATCH', `/issues/${apt19.id}`, { statusId: done.id })).status).toBe(403)
    const agents = await agentsByHandle()
    // Self-assignment only on an issue the agent reported.
    const own = (await agentCall('astra', 'POST', '/issues', { title: 'Follow-up from APT-15', type: 'task', assigneeSub: `agent:${agents.get('astra')!.id}` })).body as Issue
    expect(own).toMatchObject({ assignee: { name: 'Astra' }, delegator: MOCK_PEOPLE.sam, reporter: { name: 'Astra' } })
    expect((await agentCall('astra', 'POST', '/issues', { title: 'x', type: 'task', assigneeSub: `agent:${agents.get('claude')!.id}` })).status).toBe(403)
    expect((await agentCall('astra', 'PATCH', `/issues/${apt19.id}`, { assigneeSub: `agent:${agents.get('claude')!.id}` })).status).toBe(403)
    // Under `direct` the agent may complete.
    await call('PATCH', '/workspace', { agentCompletion: 'direct' })
    expect((await agentCall('astra', 'PATCH', `/issues/${apt19.id}`, { statusId: done.id })).body.statusId).toBe(done.id)
  })
})

describe('tracker mock: delegation, runs and requests', () => {
  test('assign → run → question → answer → finish → review → approve completes the issue as the person', async () => {
    const agents = await agentsByHandle()
    const astraSub = `agent:${agents.get('astra')!.id}`
    const apt2 = await issueNamed('APT-2')
    expect((await call('PATCH', `/issues/${apt2.id}`, { assigneeSub: `agent:${agents.get('legacy-bot')!.id}` })).body.issues[0].path).toBe('assigneeSub')
    expect((await agentCall('astra', 'POST', `/issues/${apt2.id}/runs`, {})).status).toBe(403)
    const assigned = (await call('PATCH', `/issues/${apt2.id}`, { assigneeSub: astraSub })).body as Issue
    expect(assigned).toMatchObject({ assignee: { sub: astraSub }, delegator: MOCK_PEOPLE.alex })
    expect(inboxTitles(await inbox('astra'))).toContain('assignment APT-2')
    expect((await call('POST', `/issues/${apt2.id}/runs`, {})).status).toBe(403)
    const started = await agentCall('astra', 'POST', `/issues/${apt2.id}/runs`, { session: 'astra · lane-3', note: 'reading the issue' })
    expect(started.status).toBe(201)
    const run = started.body as Run
    expect(run).toMatchObject({ state: 'running', session: 'astra · lane-3', note: 'reading the issue', reason: null, finishedAt: null })
    expect(Date.parse(run.leaseExpiresAt) - Date.parse(run.heartbeatAt)).toBe(10 * MINUTE)
    expect((await agentCall('astra', 'POST', `/issues/${apt2.id}/runs`, {})).status).toBe(409)
    expect((await agentCall('astra', 'POST', `/runs/${run.id}/heartbeat`, { note: 'running tests' })).body.note).toBe('running tests')
    expect((await agentCall('claude', 'POST', `/runs/${run.id}/heartbeat`, {})).status).toBe(403)
    // Only the run's own agent attaches a request to it, and only on the run's issue.
    expect((await agentCall('claude', 'POST', `/issues/${apt2.id}/requests`, { kind: 'question', title: 'Mine?', runId: run.id })).status).toBe(403)
    expect((await agentCall('astra', 'POST', `/issues/${(await issueNamed('APT-3')).id}/requests`, { kind: 'question', title: 'Here?', runId: run.id })).status).toBe(403)
    const question = (await agentCall('astra', 'POST', `/issues/${apt2.id}/requests`, { kind: 'question', title: 'Which key?', options: ['J/K', 'Arrows'], runId: run.id })).body as TrackerRequest
    expect(question).toMatchObject({ to: { sub: 'dev-alex' }, from: { sub: astraSub }, state: 'open', runId: run.id })
    expect((await issueNamed('APT-2')).activeRun?.state).toBe('waiting')
    expect(inboxTitles(await inbox()).filter((title) => title.startsWith('request')).at(-1)).toBe('request Which key?')
    expect((await call('POST', `/requests/${question.id}/answer`, { option: 'Tab' })).status).toBe(400)
    await as('dev-sam')
    expect((await call('POST', `/requests/${question.id}/answer`, { option: 'J/K' })).status).toBe(403)
    await as('dev-alex', 'Admin')
    expect((await call('POST', `/requests/${question.id}/answer`, { option: 'J/K', body: 'Like the list.' })).body).toMatchObject({ state: 'answered', answer: { option: 'J/K', body: 'Like the list.', by: { sub: 'dev-alex' } } })
    expect((await call('POST', `/requests/${question.id}/answer`, { option: 'J/K' })).status).toBe(409)
    expect((await issueNamed('APT-2')).activeRun?.state).toBe('running')
    expect(inboxTitles(await inbox('astra'))).toContain('answer Which key?')
    await agentCall('astra', 'POST', '/inbox/ack', { answers: [question.id] })
    expect(inboxTitles(await inbox('astra'))).not.toContain('answer Which key?')

    const links = [{ kind: 'pr', url: 'https://github.com/appthrust/tracker/pull/150', title: 'Keyboard shortcuts' }]
    expect((await agentCall('astra', 'POST', `/runs/${run.id}/finish`, { outcome: 'succeeded', summary: 'Done.', links: [{ kind: 'pr', url: 'http://x', title: 'x' }] })).status).toBe(400)
    const finished = (await agentCall('astra', 'POST', `/runs/${run.id}/finish`, { outcome: 'succeeded', summary: 'Added **J/K**.', links })).body as Run
    expect(finished).toMatchObject({ state: 'succeeded', summary: 'Added **J/K**.', links, finishedAt: expect.any(String) })
    expect((await agentCall('astra', 'POST', `/runs/${run.id}/heartbeat`, {})).status).toBe(409)
    const review = (await call('GET', `/requests?state=open&issue=${apt2.id}`)).body.items[0] as TrackerRequest
    expect(review).toMatchObject({ kind: 'review', to: { sub: 'dev-alex' }, title: `Review: ${apt2.title}`, body: 'Added **J/K**.', options: ['approve', 'reject'], runId: run.id })
    expect((await agentCall('astra', 'POST', `/requests/${review.id}/answer`, { option: 'approve' })).status).toBe(403)
    const approved = await call('POST', `/requests/${review.id}/answer`, { option: 'approve' })
    expect(approved.status).toBe(200)
    const after = await issueNamed('APT-2')
    const done = await statusNamed('Done')
    expect(after).toMatchObject({ statusId: done.id, completedAt: expect.any(String), activeRun: null, openRequestCount: 0 })
    const timeline = (await call('GET', `/issues/${apt2.id}/timeline`)).body.items as TimelineItem[]
    const status = [...timeline].reverse().find((item) => item.kind === 'activity' && item.activity.field === 'status')
    expect(status?.kind === 'activity' && status.activity.actor).toMatchObject({ sub: 'dev-alex', kind: 'person' })
  })

  test('stalled runs are derived from the lease, refused heartbeats and closed by the next start', async () => {
    const apt15 = await issueNamed('APT-15')
    const run = apt15.activeRun!
    expect((await call('POST', '/__mock/clock', { advanceMs: 11 * MINUTE })).status).toBe(200)
    expect((await issueNamed('APT-15')).activeRun?.state).toBe('stalled')
    expect((await call('GET', `/runs/${run.id}`)).body.state).toBe('stalled')
    expect((await agentCall('astra', 'POST', `/runs/${run.id}/heartbeat`, {})).status).toBe(409)
    expect((await agentCall('astra', 'POST', `/runs/${run.id}/finish`, { outcome: 'succeeded', summary: '' })).status).toBe(409)
    // The waiting run of APT-27 stalled too: its question is ignored by "Actionable", so opus-ui may restart.
    expect(inboxTitles(await inbox('opus-ui'))).toContain('assignment APT-27')
    const fresh = await agentCall('opus-ui', 'POST', `/issues/${(await issueNamed('APT-27')).id}/runs`, {})
    expect(fresh.status).toBe(201)
    const runs = (await call('GET', '/issues/APT-27/runs')).body.items as Run[]
    expect(runs.map((candidate) => [candidate.state, candidate.reason])).toEqual([
      ['running', null],
      ['failed', 'lease_expired'],
    ])
    expect((await issueNamed('APT-27')).openRequestCount).toBe(0)
    expect((await agentsByHandle()).get('astra')!.activeRuns).toBe(0)
    // A person cancels a stalled run.
    expect((await call('POST', `/runs/${run.id}/cancel`)).body).toMatchObject({ state: 'canceled', reason: 'canceled_by:dev-alex' })
    expect((await call('POST', `/runs/${run.id}/cancel`)).status).toBe(409)
  })

  test('reassigning away from an agent cancels its run and withdraws its requests; disabling cancels every run', async () => {
    const apt27 = await issueNamed('APT-27')
    const reassigned = (await call('PATCH', `/issues/${apt27.id}`, { assigneeSub: 'dev-sam' })).body as Issue
    expect(reassigned).toMatchObject({ assignee: { sub: 'dev-sam', kind: 'person' }, delegator: null, activeRun: null, openRequestCount: 0 })
    const runs = (await call('GET', `/issues/${apt27.id}/runs`)).body.items as Run[]
    expect(runs[0]).toMatchObject({ state: 'canceled', reason: 'reassigned' })
    expect(inboxTitles(await inbox())).not.toContain("request Which label should the panel's close button use?")
    const fields = ((await call('GET', `/issues/${apt27.id}/timeline`)).body.items as TimelineItem[]).flatMap((item) => (item.kind === 'activity' ? [item.activity.field] : []))
    expect(fields.slice(-2)).toEqual(['assignee', 'delegator'])

    const astra = (await agentsByHandle()).get('astra')!
    await as('dev-sam')
    expect((await call('PATCH', `/agents/${astra.id}`, { disabled: true })).status).toBe(403)
    await as('dev-alex', 'Admin')
    expect((await call('PATCH', `/agents/${astra.id}`, { handle: 'astra2' })).body.issues[0].path).toBe('handle')
    expect((await call('PATCH', `/agents/${astra.id}`, { disabled: true })).body).toMatchObject({ disabled: true, activeRuns: 0 })
    expect((await call('GET', '/issues/APT-15/runs')).body.items[0]).toMatchObject({ state: 'canceled', reason: 'canceled_by:dev-alex' })
    expect((await issueNamed('APT-15')).assignee?.agent?.disabled).toBe(true)
    expect(await agentCall('astra', 'GET', '/inbox')).toMatchObject({ status: 403, body: { error: 'key_subject' } })
  })

  test('approvals and reviews: people only; unaddressed ones by any person; an open approval blocks a successful finish', async () => {
    const apt1 = await issueNamed('APT-1')
    const approval = ((await call('GET', `/requests?issue=${apt1.id}`)).body.items as TrackerRequest[])[0]!
    expect(approval).toMatchObject({ kind: 'approval', to: null, options: ['approve', 'reject'] })
    expect((await agentCall('astra', 'POST', `/requests/${approval.id}/answer`, { option: 'approve' })).status).toBe(403)
    expect((await call('POST', `/requests/${approval.id}/answer`, { body: 'no option' })).body.issues[0].path).toBe('option')
    await as('dev-jordan')
    expect((await call('POST', `/requests/${approval.id}/answer`, { option: 'reject', body: 'Next sprint.' })).body.answer).toMatchObject({ option: 'reject', by: { sub: 'dev-jordan' } })
    expect(inboxTitles(await inbox('claude'))).toContain('answer Add APT-1 to the current sprint?')

    // The review of APT-16 is Alex's; Sam (not Admin) cannot answer it.
    const review = ((await call('GET', '/requests?state=open&to=dev-alex')).body.items as TrackerRequest[]).find((request) => request.kind === 'review')!
    await as('dev-sam')
    expect((await call('POST', `/requests/${review.id}/answer`, { option: 'approve' })).status).toBe(403)
    await as('dev-alex', 'Admin')
    expect((await call('POST', `/requests/${review.id}/answer`, { option: 'reject', body: 'Add a test for the refresh path.' })).body.state).toBe('answered')
    expect((await issueNamed('APT-16')).statusId).toBe((await statusNamed('In Review')).id)

    const apt15 = await issueNamed('APT-15')
    const run = apt15.activeRun!
    expect((await agentCall('astra', 'POST', `/issues/${apt15.id}/requests`, { kind: 'approval', title: 'Delete testdata?', options: ['yes'] })).status).toBe(400)
    expect((await agentCall('astra', 'POST', `/issues/${apt15.id}/requests`, { kind: 'approval', title: 'Delete testdata?', to: `agent:${(await agentsByHandle()).get('claude')!.id}` })).status).toBe(400)
    const ask = (await agentCall('astra', 'POST', `/issues/${apt15.id}/requests`, { kind: 'approval', title: 'Delete testdata?', runId: run.id })).body as TrackerRequest
    expect(ask.to?.sub).toBe('dev-alex')
    expect((await agentCall('astra', 'POST', `/runs/${run.id}/finish`, { outcome: 'succeeded', summary: 'x' })).status).toBe(409)
    expect((await call('POST', `/requests/${ask.id}/withdraw`)).status).toBe(403)
    expect((await agentCall('astra', 'POST', `/requests/${ask.id}/withdraw`)).body.state).toBe('withdrawn')
    expect((await issueNamed('APT-15')).activeRun?.state).toBe('running')
  })

  test('Idempotency-Key replays the first response; another body is 409', async () => {
    const apt3 = await issueNamed('APT-3')
    const first = await call('POST', `/issues/${apt3.id}/comments`, { body: 'once' }, { 'Idempotency-Key': 'k-1' })
    const again = await call('POST', `/issues/${apt3.id}/comments`, { body: 'once' }, { 'Idempotency-Key': 'k-1' })
    expect(again).toMatchObject({ status: 201, body: { id: first.body.id } })
    expect(((await call('GET', `/issues/${apt3.id}/timeline`)).body.items as TimelineItem[]).filter((item) => item.kind === 'comment')).toHaveLength(1)
    expect((await call('POST', `/issues/${apt3.id}/comments`, { body: 'twice' }, { 'Idempotency-Key': 'k-1' })).status).toBe(409)
    // Keys are per actor.
    expect((await agentCall('astra', 'POST', `/issues/${apt3.id}/comments`, { body: 'twice' }, { 'Idempotency-Key': 'k-1' })).status).toBe(201)
    expect((await call('POST', `/issues/${apt3.id}/comments`, { body: 'x' }, { 'Idempotency-Key': 'k'.repeat(129) })).status).toBe(400)
  })

  test('expectedUpdatedAt: a stale edit is 409 conflict', async () => {
    const apt3 = await issueNamed('APT-3')
    expect((await call('PATCH', `/issues/${apt3.id}`, { title: 'Fresh', expectedUpdatedAt: apt3.updatedAt })).body.title).toBe('Fresh')
    expect(await call('PATCH', `/issues/${apt3.id}`, { title: 'Stale', expectedUpdatedAt: apt3.updatedAt })).toMatchObject({ status: 409, body: { error: 'conflict' } })
  })

  test('mentions: @handle of an active agent, one row per comment and agent, acknowledged by the agent', async () => {
    const apt3 = await issueNamed('APT-3')
    const comment = (await call('POST', `/issues/${apt3.id}/comments`, { body: '@claude and @claude, also @nobody and email@astra.dev' })).body
    expect(comment.mentions.map((actor: { name: string }) => actor.name)).toEqual(['Claude'])
    const mention = (await inbox('claude')).find((item) => item.kind === 'mention')
    expect(mention).toMatchObject({ kind: 'mention', issue: { identifier: 'APT-3' }, comment: { id: comment.id } })
    await agentCall('claude', 'POST', '/inbox/ack', { mentions: [comment.id] })
    expect((await inbox('claude')).some((item) => item.kind === 'mention')).toBe(false)
  })

  test('events: ascending from a cursor, `after` omitted starts now', async () => {
    const start = (await call('GET', '/events')).body
    expect(start.items).toEqual([])
    const apt3 = await issueNamed('APT-3')
    await call('PATCH', `/issues/${apt3.id}`, { priority: 'low', title: 'Renamed' })
    await call('POST', `/issues/${apt3.id}/comments`, { body: 'hi' })
    const page = (await call('GET', `/events?after=${start.next}`)).body as { items: TrackerEvent[]; next: number }
    expect(page.items.map((event) => [event.type, event.issue?.identifier])).toEqual([
      ['issue.updated', 'APT-3'],
      ['comment.created', 'APT-3'],
    ])
    expect(page.items[0]!.data).toEqual({ fields: ['title', 'priority'] })
    expect(page.next).toBe(page.items[1]!.seq)
    expect((await call('GET', `/events?after=${page.next}`)).body).toEqual({ items: [], next: page.next })
    expect((await call('GET', '/events?limit=501')).status).toBe(400)
  })

  test('agent registry: Admin registers with an immutable unique handle; the guide is Markdown', async () => {
    expect((await call('POST', '/agents', { handle: 'Astra', name: 'X', ownerSub: 'dev-alex' })).body.issues[0].path).toBe('handle')
    expect((await call('POST', '/agents', { handle: 'astra', name: 'X', ownerSub: 'dev-alex' })).status).toBe(409)
    expect((await call('POST', '/agents', { handle: 'scout', name: 'Scout', ownerSub: 'agent:x' })).body.issues[0].path).toBe('ownerSub')
    const created = await call('POST', '/agents', { handle: 'scout', name: 'Scout', description: 'Finds flaky tests.', ownerSub: 'dev-jordan' })
    expect(created).toMatchObject({ status: 201, body: { handle: 'scout', owner: { sub: 'dev-jordan', name: 'Jordan Lee' }, registeredByKey: null, activeRuns: 0, openRequests: 0, lastSeenAt: null } })
    expect((await call('PATCH', `/agents/${created.body.id}`, { name: 'Scout 2', ownerSub: 'dev-sam' })).body).toMatchObject({ name: 'Scout 2', owner: { sub: 'dev-sam' } })
    const guide = await call('GET', '/agent-guide')
    expect(guide.headers.get('Content-Type')).toContain('text/markdown')
    expect(new TextDecoder().decode(guide.body)).toContain('POST /runs/{id}/heartbeat')
  })
})
