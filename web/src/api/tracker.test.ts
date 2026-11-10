import { beforeEach, describe, expect, test } from 'bun:test'
import { trackerRoutes } from '../dev/mock-tracker'
import { listHref, parseFilterParam } from '../routes/paths'
import { applyIssuePatch, retryQuery } from './queries'
import { createTrackerApi, isTrackerError, issueSearch, TrackerApiError } from './tracker'

type Call = { input: string; init: RequestInit }

/** The client wired to the in-repo mock, recording every request it sends. */
function mockApi() {
  const calls: Call[] = []
  const api = createTrackerApi(async (input, init) => {
    calls.push({ input, init })
    const url = new URL(input, 'http://tracker.test')
    return (await trackerRoutes(new Request(url, init), url)) ?? new Response(null, { status: 404 })
  }, () => false)
  return { api, calls }
}

async function rejection(promise: Promise<unknown>): Promise<TrackerApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof TrackerApiError) return error
    throw error
  }
  throw new Error('expected the call to fail')
}

beforeEach(async () => {
  const url = new URL('http://tracker.test/api/tracker/v1/__mock/reset')
  await trackerRoutes(new Request(url, { method: 'POST' }), url)
})

describe('tracker API client', () => {
  test('reads go to same-origin /api/tracker/v1 without a token; the filter travels as JSON', async () => {
    const { api, calls } = mockApi()
    await api.me()
    const page = await api.issues.list({ filter: { type: ['bug'], q: '' as never }, sort: 'priority', limit: 5 })
    expect(page.items).toHaveLength(5)
    await api.issues.list({ filter: {}, cursor: page.nextCursor })
    expect(calls.map((call) => call.input)).toEqual([
      '/api/tracker/v1/me',
      `/api/tracker/v1/issues?filter=${encodeURIComponent('{"type":["bug"],"q":""}')}&sort=priority&limit=5`,
      `/api/tracker/v1/issues?cursor=${page.nextCursor}`,
    ])
    for (const call of calls) {
      expect(call.init.credentials).toBe('same-origin')
      expect(new Headers(call.init.headers).has('Authorization')).toBe(false)
    }
    expect(issueSearch({ filter: {} })).toBe('')
  })

  test('the reporter filter travels as JSON, survives the page URL, and a bad one is a field error', async () => {
    const { api, calls } = mockApi()
    const page = await api.issues.list({ filter: { reporter: ['me'] }, sort: 'created' })
    expect(calls.at(-1)?.input).toBe(`/api/tracker/v1/issues?filter=${encodeURIComponent('{"reporter":["me"]}')}&sort=created`)
    expect(page.items.length).toBeGreaterThanOrEqual(8)
    expect(page.items.every((issue) => issue.reporter.sub === 'dev-alex')).toBe(true)
    const href = listHref('/reported', { filter: { reporter: ['me', 'dev-sam'], type: ['bug'] }, project: 'P1' })
    const search = new URLSearchParams(href.slice(href.indexOf('?') + 1))
    expect(parseFilterParam(search.get('filter') ?? undefined)).toEqual({ reporter: ['me', 'dev-sam'], type: ['bug'] })
    expect(search.get('project')).toBe('P1')
    const error = await rejection(api.issues.list({ filter: { reporter: [''] } }))
    expect(error).toMatchObject({ status: 400, code: 'invalid' })
    expect(error.issues?.[0]?.path).toBe('filter.reporter')
  })

  test('writes send JSON; uploads send multipart without a JSON content type; deletes answer 204', async () => {
    const { api, calls } = mockApi()
    const issue = await api.issues.create({ title: 'New', type: 'task' })
    expect(new Headers(calls.at(-1)?.init.headers).get('Content-Type')).toBe('application/json')
    expect(calls.at(-1)?.init.body).toBe(JSON.stringify({ title: 'New', type: 'task' }))
    const attachment = await api.issues.attach(issue.id, new File(['hello'], 'note.txt', { type: 'text/plain' }))
    expect(attachment.filename).toBe('note.txt')
    expect(calls.at(-1)?.init.body).toBeInstanceOf(FormData)
    expect(new Headers(calls.at(-1)?.init.headers).has('Content-Type')).toBe(false)
    expect((await api.issues.timeline(issue.id)).map((item) => item.kind === 'activity' && item.activity.field)).toEqual(['created', 'attachment'])
    expect(await api.attachments.remove(attachment.id)).toBeUndefined()
    expect(calls.at(-1)?.init.method).toBe('DELETE')
  })

  test('errors keep the code and field issues; unanswered calls are transient and retried, answers are final', async () => {
    const { api } = mockApi()
    const invalid = await rejection(api.issues.create({ title: 'x', type: 'bug' }))
    expect(invalid).toMatchObject({ status: 400, code: 'invalid', transient: false })
    expect(invalid.issues[0]?.path).toBe('report')
    expect(isTrackerError(await rejection(api.issues.get('APT-999')), 'not_found')).toBe(true)
    expect(retryQuery(0, invalid)).toBe(false)

    const offline = createTrackerApi(() => Promise.reject(new Error('offline')), () => false)
    const unanswered = await rejection(offline.me())
    expect(unanswered).toMatchObject({ status: 0, transient: true })
    expect(retryQuery(0, unanswered)).toBe(true)
    const proxy = createTrackerApi(async () => new Response('<html>bad gateway</html>', { status: 502 }), () => false)
    expect(await rejection(proxy.me())).toMatchObject({ status: 502, code: 'unknown', transient: true })
    const store = createTrackerApi(async () => Response.json({ error: 'tracker_store_unavailable', message: 'database unreachable' }, { status: 503 }), () => false)
    expect(await rejection(store.me())).toMatchObject({ status: 503, code: 'tracker_store_unavailable', transient: false })
  })

  test('optimistic patch: changed fields only; clearing the assignee or picking one shows at once', async () => {
    const { api } = mockApi()
    const issue = await api.issues.get('APT-2')
    const person = { sub: 'dev-jordan', name: 'Jordan Lee' }
    const next = applyIssuePatch(issue, { statusId: 'S', priority: 'low', labelIds: [], assigneeSub: person.sub }, person)
    expect(next).toMatchObject({ statusId: 'S', priority: 'low', labelIds: [], assignee: person, title: issue.title, description: issue.description })
    expect(applyIssuePatch(issue, { assigneeSub: null }).assignee).toBeNull()
    expect(applyIssuePatch(issue, { projectId: 'P' }).projectId).toBe('P')
    expect(applyIssuePatch({ ...issue, projectId: 'P' }, { projectId: null }).projectId).toBeNull()
    expect(applyIssuePatch({ ...issue, projectId: 'P' }, { title: 'x' }).projectId).toBe('P')
    expect(issue.statusId).not.toBe('S')
  })

  test('optimistic parent: the derived epic and story follow the picked parent; clearing it clears both', async () => {
    const { api } = mockApi()
    const task = await api.issues.get('APT-5')
    const [epic, story, parentTask] = await Promise.all([api.issues.get('APT-32'), api.issues.get('APT-35'), api.issues.get('APT-3')])
    expect(task).toMatchObject({ parent: null, epic: null, story: null })
    const ref = (issue: typeof epic) => ({ id: issue.id, identifier: issue.identifier, title: issue.title, statusId: issue.statusId })
    expect(applyIssuePatch(task, { parentId: story.id }, undefined, story)).toMatchObject({ parent: ref(story), story: ref(story), epic: story.epic })
    expect(applyIssuePatch(task, { parentId: epic.id }, undefined, epic)).toMatchObject({ parent: ref(epic), epic: ref(epic), story: null })
    expect(applyIssuePatch(task, { parentId: parentTask.id }, undefined, parentTask)).toMatchObject({ parent: ref(parentTask), epic: parentTask.epic, story: parentTask.story })
    // What the server answers after the write matches the optimistic shape.
    expect(await api.issues.update(task.id, { parentId: story.id })).toMatchObject({ parent: ref(story), story: ref(story), epic: story.epic })
    expect(applyIssuePatch(story, { parentId: null })).toMatchObject({ parent: null, epic: null, story: null })
    expect(listHref('/board', { group: 'epic', project: 'P1' })).toBe('/board?group=epic&project=P1')
  })
})
