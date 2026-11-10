import { beforeEach, describe, expect, test } from 'bun:test'
import type { Attachment, Issue, IssuePage, Label, Project, Status, TimelineItem, View } from '../api/tracker'
import { MOCK_PEOPLE, trackerRoutes } from './mock-tracker'

const BASE = '/api/tracker/v1'

async function call(method: string, path: string, body?: unknown) {
  const url = new URL(`${BASE}${path}`, 'http://mock.test')
  const init: RequestInit = { method }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
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
    expect((await call('GET', '/me')).body).toEqual({ ...MOCK_PEOPLE.alex, role: 'Admin', isAdmin: true })
    expect((await call('GET', '/workspace')).body).toMatchObject({ key: 'APT', issueCount: 30 })
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
    expect(views.map((view) => [view.name, view.shared, view.filter])).toEqual([
      ['Bugs', true, { type: ['bug'] }],
      ['My issues', true, { assignee: ['me'] }],
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
    const all = (await list('?sort=number')).items
    expect(all).toHaveLength(30)
    const ordered = await statuses()
    const first = all[0]!
    expect(first).toMatchObject({ identifier: 'APT-1', title: 'Dashboard loses filters on reload', type: 'bug', priority: 'urgent', statusId: ordered[0]!.id, reporter: MOCK_PEOPLE.alex, assignee: MOCK_PEOPLE.sam })
    expect(first.report).toEqual({ environment: 'appthrust.ink', surface: 'dashboard', version: '0.1.0', steps: 'Open the affected surface and repeat the action.', expected: 'The action completes successfully.', actual: 'The observed behavior differs from the expected result.' })
    expect(all[4]).toMatchObject({ identifier: 'APT-5', type: 'feature', priority: 'none', statusId: ordered[4]!.id, report: null, completedAt: expect.any(String) })
    expect(new Set(all.map((issue) => issue.statusId)).size).toBe(6)
  })
})

describe('tracker mock: issues', () => {
  test('filter, sort and cursor paging; malformed parameters are 400 invalid', async () => {
    expect((await list(filterQuery({ type: ['bug'] }))).items).toHaveLength(10)
    expect((await list(filterQuery({ assignee: ['me'] }))).items.every((issue) => issue.assignee?.sub === 'dev-alex')).toBe(true)
    expect((await list(filterQuery({ category: ['started'] }))).items).toHaveLength(10)
    expect((await list(filterQuery({ q: 'cluster' }))).items.map((issue) => issue.identifier).sort()).toEqual(['APT-10', 'APT-28', 'APT-3'])
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: IssuePage = await list(`?sort=number&limit=12${cursor ? `&cursor=${cursor}` : ''}`)
      seen.push(...page.items.map((issue) => issue.identifier))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toHaveLength(30)
    expect(seen[0]).toBe('APT-1')
    expect(new Set(seen).size).toBe(30)
    const urgentFirst = (await list('?sort=priority')).items
    expect(urgentFirst.slice(0, 6).every((issue) => issue.priority === 'urgent')).toBe(true)
    for (const bad of ['?filter=%7Bnope', filterQuery({ colour: ['red'] }), filterQuery({ type: ['epic'] }), '?sort=title', '?limit=500']) {
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
    expect(created.reporter).toEqual({ sub: 'dev-riley', name: 'Riley Park' })
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
    expect(created.body).toMatchObject({ identifier: 'APT-31', title: 'Board drag fails', statusId: (await statusNamed('Backlog')).id, reporter: MOCK_PEOPLE.alex, report: { environment: 'craftsman', surface: 'dashboard', version: '0.1.0' } })
    expect(created.body.report.steps).toBeUndefined()
    expect((await call('GET', '/workspace')).body.issueCount).toBe(31)
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
    expect((await list()).items).toHaveLength(29)
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
    big.append('file', new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }))
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
      ['Platform API', 'purple', false, 5],
    ])
    const byName = Object.fromEntries(items.map((project) => [project.name, project.id]))
    const order = [byName.Dashboard, byName['Platform API'], byName['Builder Console']]
    const all = (await list('?sort=number')).items
    for (const issue of all) expect(issue.projectId, issue.identifier).toBe(issue.number % 3 === 0 ? null : order[((issue.number % 3) + (issue.number % 2)) % 3]!)
    const closed = new Set((await statuses()).filter((status) => status.category === 'completed' || status.category === 'canceled').map((status) => status.id))
    for (const project of items) {
      expect(project.openIssueCount, project.name).toBe(all.filter((issue) => issue.projectId === project.id && !closed.has(issue.statusId)).length)
    }
    expect((await call('GET', `/projects/${byName.Dashboard}`)).body).toMatchObject({ name: 'Dashboard', issueCount: 5 })
    expect((await call('GET', '/projects/nope')).status).toBe(404)
  })

  test('filter: project ids OR `none`', async () => {
    const dashboard = await projectNamed('Dashboard')
    expect((await list(filterQuery({ project: ['none'] }))).items).toHaveLength(10)
    expect((await list(filterQuery({ project: [dashboard.id] }))).items.every((issue) => issue.projectId === dashboard.id)).toBe(true)
    expect((await list(filterQuery({ project: [dashboard.id, 'none'] }))).items).toHaveLength(15)
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
    expect(((await call('GET', '/views')).body.items as View[]).map((view) => view.name)).toEqual(['Bugs', 'My issues', 'Sam bugs'])
    const bugs = ((await call('GET', '/views')).body.items as View[])[0]!
    expect((await call('PATCH', `/views/${bugs.id}`, { name: 'x' })).status).toBe(403)
    expect((await call('PATCH', `/views/${mine.body.id}`, { name: 'Sam: bugs' })).body.name).toBe('Sam: bugs')
    expect((await call('POST', '/views', { name: 'bad', filter: { nope: [] } })).status).toBe(400)
    await as('dev-jordan')
    expect(((await call('GET', '/views')).body.items as View[]).map((view) => view.name)).toEqual(['Bugs', 'My issues'])
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
