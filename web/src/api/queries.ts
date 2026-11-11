// Read-model loading and writes (React Query). Every query is a
// `queryOptions()` / `infiniteQueryOptions()` factory so route loaders
// (`ensureQueryData`) and components share one key and fetcher. Freshness:
// every query refetches every 15 s while the tab is visible and on window
// focus (no push in v1). Issue edits (status, priority, assignee, labels,
// project, parent, …) are optimistic: lists and the open issue change at once
// and roll back on failure. Sprints, burndown and velocity share one key
// prefix, refreshed by every issue write (estimates, statuses and membership
// move the ledger).
import { infiniteQueryOptions, QueryClient, queryOptions, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { compactFilter, levelOf } from '../model/issues'
import { sprintRef } from '../model/sprints'
import {
  trackerApi,
  TrackerApiError,
  type CreateIssueInput,
  type CreateProjectInput,
  type CreateSprintInput,
  type CreateViewInput,
  type Filter,
  type Issue,
  type IssuePage,
  type IssueSummary,
  type Label,
  type LabelColor,
  type Person,
  type Project,
  type Sort,
  type Sprint,
  type SprintRef,
  type StatusCategory,
  type Unit,
  type UpdateIssueInput,
  type UpdateProjectInput,
  type UpdateSprintInput,
  type UpdateViewInput,
  type UpdateWorkspaceInput,
} from './tracker'

/** Retries for a call nothing answered (rollout gap, network blip). */
const TRANSIENT_RETRIES = 3
export const REFETCH_INTERVAL_MS = 15_000

/** Any answer with a status (4xx, coded 5xx) is final; unanswered calls are retried with backoff. */
export const retryQuery = (failureCount: number, error: unknown) =>
  error instanceof TrackerApiError && !error.transient ? false : failureCount < TRANSIENT_RETRIES

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: retryQuery,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      staleTime: 5_000,
      refetchInterval: REFETCH_INTERVAL_MS,
      refetchOnWindowFocus: true,
    },
  },
})

/** Every tracker key starts with this. */
export const TRACKER_KEY = ['tracker'] as const
const ISSUES_KEY = [...TRACKER_KEY, 'issues'] as const
const ISSUE_KEY = [...TRACKER_KEY, 'issue'] as const
const SPRINTS_KEY = [...TRACKER_KEY, 'sprints'] as const

export const meQuery = queryOptions({ queryKey: [...TRACKER_KEY, 'me'], queryFn: () => trackerApi.me(), staleTime: 60_000 })
export const workspaceQuery = queryOptions({ queryKey: [...TRACKER_KEY, 'workspace'], queryFn: () => trackerApi.workspace.get() })
export const statusesQuery = queryOptions({ queryKey: [...TRACKER_KEY, 'statuses'], queryFn: () => trackerApi.statuses.list() })
export const labelsQuery = queryOptions({ queryKey: [...TRACKER_KEY, 'labels'], queryFn: () => trackerApi.labels.list() })
export const viewsQuery = queryOptions({ queryKey: [...TRACKER_KEY, 'views'], queryFn: () => trackerApi.views.list() })
/** Every project, archived included: issues keep showing an archived project's name; pickers offer active ones only. */
export const projectsQuery = queryOptions({ queryKey: [...TRACKER_KEY, 'projects'], queryFn: () => trackerApi.projects.list({ includeArchived: true }) })
/** Every sprint in API order (active, planned by start, closed newest first). */
export const sprintsQuery = queryOptions({ queryKey: [...SPRINTS_KEY, 'list'], queryFn: () => trackerApi.sprints.list() })
export const sprintQuery = (id: string) => queryOptions({ queryKey: [...SPRINTS_KEY, 'one', id], queryFn: () => trackerApi.sprints.get(id) })
export const burndownQuery = (id: string, unit: Unit, project?: string | null) =>
  queryOptions({ queryKey: [...SPRINTS_KEY, 'burndown', id, unit, project ?? null], queryFn: () => trackerApi.sprints.burndown(id, { unit, project }) })
export const velocityQuery = (unit: Unit, project?: string | null) => queryOptions({ queryKey: [...SPRINTS_KEY, 'velocity', unit, project ?? null], queryFn: () => trackerApi.velocity({ unit, project }) })

/** Lists load the server maximum per page; "もっと見る" fetches the next cursor page. */
export const ISSUE_PAGE_SIZE = 200

export const issuesQuery = (filter: Filter, sort: Sort) => {
  const compact = compactFilter(filter)
  return infiniteQueryOptions({
    queryKey: [...ISSUES_KEY, compact, sort],
    queryFn: ({ pageParam }) => trackerApi.issues.list({ filter: compact, sort, cursor: pageParam, limit: ISSUE_PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  })
}

/**
 * Every matching issue, following `nextCursor` to the end: grouped lists and
 * boards and the epics overview need complete groups and counts (a page holds
 * at most the 200 most recent).
 */
export const allIssuesQuery = (filter: Filter, sort: Sort) => {
  const compact = compactFilter(filter)
  return queryOptions({
    queryKey: [...ISSUES_KEY, 'all', compact, sort],
    queryFn: async (): Promise<IssuePage> => {
      const items: IssueSummary[] = []
      let cursor: string | null = null
      do {
        const page: IssuePage = await trackerApi.issues.list({ filter: compact, sort, cursor, limit: ISSUE_PAGE_SIZE })
        items.push(...page.items)
        cursor = page.nextCursor
      } while (cursor)
      return { items, nextCursor: null }
    },
  })
}

/** Every epic (resp. story), by number: group headers, pickers and the overview. */
export const epicsQuery = allIssuesQuery({ type: ['epic'] }, 'number')
export const storiesQuery = allIssuesQuery({ type: ['story'] }, 'number')
/** An issue's direct children with their types (hierarchy checks, the epic/story child list). */
export const childrenQuery = (issueId: string) => allIssuesQuery({ parent: issueId }, 'number')

/** The sidebar's open count for "Reported by me" reads one capped page; a next cursor means "more than the cap". */
export const REPORTED_OPEN_CAP = 99
export const reportedOpenQuery = queryOptions({
  queryKey: [...ISSUES_KEY, 'reported-open'],
  queryFn: () => trackerApi.issues.list({ filter: { reporter: ['me'], category: ['backlog', 'unstarted', 'started'] }, limit: REPORTED_OPEN_CAP }),
})

/** Issue search for the palette and relation pickers (title/identifier words). */
export const issueSearchQuery = (q: string) =>
  queryOptions({
    queryKey: [...ISSUES_KEY, 'search', q.trim()],
    queryFn: () => trackerApi.issues.list({ filter: q.trim() ? { q: q.trim() } : {}, sort: 'updated', limit: 20 }),
    staleTime: 10_000,
    refetchInterval: false,
  })

/** `APT-12` (normalized to upper case) or ULID. */
export const issueQuery = (key: string) =>
  queryOptions({ queryKey: [...ISSUE_KEY, key.toUpperCase()], queryFn: () => trackerApi.issues.get(key) })

export const timelineQuery = (issueId: string) => queryOptions({ queryKey: [...TRACKER_KEY, 'timeline', issueId], queryFn: () => trackerApi.issues.timeline(issueId) })

export const peopleQuery = (q: string) =>
  queryOptions({ queryKey: [...TRACKER_KEY, 'people', q.trim()], queryFn: () => trackerApi.people(q.trim() || undefined), staleTime: 60_000, refetchInterval: false })

// --- optimistic issue edits --------------------------------------------------

/**
 * The summary/issue as it will look after `input`; `assignee` is the picked
 * person for display, `parent` the picked parent's summary, from which the
 * derived `epic`/`story` follow at once (the server recomputes them), and
 * `sprint` the ref of the sprint `sprintId` names.
 */
export function applyIssuePatch<T extends IssueSummary>(issue: T, input: UpdateIssueInput, assignee?: Person | null, parent?: IssueSummary | null, sprint?: SprintRef | null): T {
  const next: T = { ...issue }
  if (input.title !== undefined) next.title = input.title
  if (input.type !== undefined) next.type = input.type
  if (input.priority !== undefined) next.priority = input.priority
  if (input.statusId !== undefined) next.statusId = input.statusId
  if (input.labelIds !== undefined) next.labelIds = input.labelIds
  if (input.dueOn !== undefined) next.dueOn = input.dueOn
  if (input.report !== undefined) next.report = input.report
  if (input.projectId !== undefined) next.projectId = input.projectId
  if (input.estimate !== undefined) next.estimate = input.estimate
  if (input.sprintId !== undefined) next.sprint = input.sprintId === null ? null : (sprint ?? issue.sprint)
  if (input.assigneeSub !== undefined) next.assignee = input.assigneeSub === null ? null : (assignee ?? issue.assignee)
  if (input.parentId === null) Object.assign(next, { parent: null, epic: null, story: null })
  else if (input.parentId !== undefined && parent?.id === input.parentId) {
    const ref = { id: parent.id, identifier: parent.identifier, title: parent.title, statusId: parent.statusId }
    // Nearest strict ancestors: the parent itself when it is an epic/story, else the parent's own.
    next.parent = ref
    next.epic = parent.type === 'epic' ? ref : parent.epic
    next.story = parent.type === 'story' ? ref : levelOf(parent.type) === 0 ? parent.story : null
  }
  if ('description' in next && input.description !== undefined) (next as unknown as Issue).description = input.description
  return next
}

type IssueLists = InfiniteData<IssuePage, string | null> | IssuePage

/** Writes `update` into every cached list (paged or loaded whole) and the cached issue detail with this id. */
function patchCaches(client: QueryClient, id: string, update: <T extends IssueSummary>(issue: T) => T) {
  const patchPage = (page: IssuePage) => ({ ...page, items: page.items.map((item) => (item.id === id ? update(item) : item)) })
  client.setQueriesData<IssueLists>({ queryKey: ISSUES_KEY }, (data) => (!data ? data : 'pages' in data ? { ...data, pages: data.pages.map(patchPage) } : 'items' in data ? patchPage(data) : data))
  client.setQueriesData<Issue>({ queryKey: ISSUE_KEY }, (data) => (data && data.id === id ? update(data) : data))
}

export type IssueEdit = { id: string; input: UpdateIssueInput; assignee?: Person | null; parent?: IssueSummary | null }

export function useUpdateIssue() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: IssueEdit) => trackerApi.issues.update(id, input),
    onMutate: async ({ id, input, assignee, parent }) => {
      await Promise.all([client.cancelQueries({ queryKey: ISSUES_KEY }), client.cancelQueries({ queryKey: ISSUE_KEY })])
      const lists = client.getQueriesData<IssueLists>({ queryKey: ISSUES_KEY })
      const details = client.getQueriesData<Issue>({ queryKey: ISSUE_KEY })
      const picked = input.sprintId ? client.getQueryData<Sprint[]>(sprintsQuery.queryKey)?.find((sprint) => sprint.id === input.sprintId) : undefined
      patchCaches(client, id, (issue) => applyIssuePatch(issue, input, assignee, parent, picked ? sprintRef(picked) : undefined))
      return { lists, details }
    },
    onError: (_error, _edit, snapshot) => {
      for (const [key, data] of [...(snapshot?.lists ?? []), ...(snapshot?.details ?? [])]) client.setQueryData(key, data)
    },
    onSuccess: (issue) => {
      const { description: _description, children: _children, blocks: _blocks, blockedBy: _blockedBy, ...summary } = issue
      patchCaches(client, issue.id, (cached) => ('description' in cached ? ({ ...cached, ...issue } as typeof cached) : ({ ...cached, ...summary } as typeof cached)))
    },
    onSettled: (_issue, _error, { id }) => {
      void client.invalidateQueries({ queryKey: ISSUES_KEY })
      void client.invalidateQueries({ queryKey: ISSUE_KEY })
      void client.invalidateQueries({ queryKey: [...TRACKER_KEY, 'timeline', id] })
      // Project and status changes move the per-project counts.
      void client.invalidateQueries({ queryKey: projectsQuery.queryKey })
      // Estimates, statuses and membership move sprint tallies and charts.
      void client.invalidateQueries({ queryKey: SPRINTS_KEY })
    },
  })
}

/** Edits several issues at once (palette on a multi-selection); each is optimistic on its own. */
export function useUpdateIssues() {
  const update = useUpdateIssue()
  return {
    ...update,
    run: (ids: string[], input: UpdateIssueInput, assignee?: Person | null, parent?: IssueSummary | null) => Promise.allSettled(ids.map((id) => update.mutateAsync({ id, input, assignee, parent }))),
  }
}

const invalidateIssues = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: ISSUES_KEY }),
    client.invalidateQueries({ queryKey: ISSUE_KEY }),
    client.invalidateQueries({ queryKey: workspaceQuery.queryKey }),
    client.invalidateQueries({ queryKey: projectsQuery.queryKey }),
    client.invalidateQueries({ queryKey: SPRINTS_KEY }),
  ])

export function useCreateIssue() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateIssueInput) => trackerApi.issues.create(input),
    onSuccess: (issue) => {
      client.setQueryData(issueQuery(issue.identifier).queryKey, issue)
      void invalidateIssues(client)
    },
  })
}

export function useDeleteIssue() {
  const client = useQueryClient()
  return useMutation({ mutationFn: (id: string) => trackerApi.issues.remove(id), onSuccess: () => void invalidateIssues(client) })
}

/** Comment/attachment writes refresh the timeline and the counts shown on rows. */
function useIssueChildMutation<V, R>(issueId: string, mutationFn: (variables: V) => Promise<R>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: timelineQuery(issueId).queryKey })
      void client.invalidateQueries({ queryKey: ISSUES_KEY })
      void client.invalidateQueries({ queryKey: ISSUE_KEY })
    },
  })
}

export const useAddComment = (issueId: string) => useIssueChildMutation(issueId, (body: string) => trackerApi.issues.comment(issueId, body))
export const useEditComment = (issueId: string) => useIssueChildMutation(issueId, ({ id, body }: { id: string; body: string }) => trackerApi.comments.update(id, body))
export const useDeleteComment = (issueId: string) => useIssueChildMutation(issueId, (id: string) => trackerApi.comments.remove(id))
export const useAttach = (issueId: string) => useIssueChildMutation(issueId, (file: File) => trackerApi.issues.attach(issueId, file))
export const useDeleteAttachment = (issueId: string) => useIssueChildMutation(issueId, (id: string) => trackerApi.attachments.remove(id))

// --- views and settings --------------------------------------------------------

export function useViewMutations() {
  const client = useQueryClient()
  const onSuccess = () => void client.invalidateQueries({ queryKey: viewsQuery.queryKey })
  return {
    create: useMutation({
      mutationFn: (input: CreateViewInput) => trackerApi.views.create(input),
      // The caller navigates to the new view at once; its route must find it in the cache.
      onSuccess: (view) => {
        client.setQueryData(viewsQuery.queryKey, (views) => [...(views ?? []).filter((candidate) => candidate.id !== view.id), view])
        onSuccess()
      },
    }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateViewInput }) => trackerApi.views.update(id, input), onSuccess }),
    remove: useMutation({ mutationFn: (id: string) => trackerApi.views.remove(id), onSuccess }),
  }
}

export function useUpdateWorkspace() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateWorkspaceInput) => trackerApi.workspace.update(input),
    onSuccess: (workspace) => {
      client.setQueryData(workspaceQuery.queryKey, workspace)
      // A new key renames every identifier.
      void invalidateIssues(client)
    },
  })
}

export function useStatusMutations() {
  const client = useQueryClient()
  const onSuccess = () => void client.invalidateQueries({ queryKey: statusesQuery.queryKey })
  return {
    create: useMutation({ mutationFn: (input: { name: string; category: StatusCategory; color?: string }) => trackerApi.statuses.create(input), onSuccess }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: { name?: string; color?: string } }) => trackerApi.statuses.update(id, input), onSuccess }),
    remove: useMutation({ mutationFn: (id: string) => trackerApi.statuses.remove(id), onSuccess }),
    reorder: useMutation({
      mutationFn: (ids: string[]) => trackerApi.statuses.reorder(ids),
      onSuccess: (statuses) => client.setQueryData(statusesQuery.queryKey, statuses),
    }),
  }
}

export function useLabelMutations() {
  const client = useQueryClient()
  const onSuccess = () => {
    void client.invalidateQueries({ queryKey: labelsQuery.queryKey })
    void client.invalidateQueries({ queryKey: ISSUES_KEY })
  }
  return {
    create: useMutation({ mutationFn: (input: { name: string; color: LabelColor }) => trackerApi.labels.create(input), onSuccess }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: { name?: string; color?: LabelColor } }) => trackerApi.labels.update(id, input), onSuccess }),
    remove: useMutation({ mutationFn: (id: Label['id']) => trackerApi.labels.remove(id), onSuccess }),
  }
}

export function useProjectMutations() {
  const client = useQueryClient()
  const onSuccess = () => void client.invalidateQueries({ queryKey: projectsQuery.queryKey })
  return {
    create: useMutation({
      mutationFn: (input: CreateProjectInput) => trackerApi.projects.create(input),
      // Pickers select the new project at once; it must already be in the cache.
      onSuccess: (project) => {
        client.setQueryData(projectsQuery.queryKey, (projects) => [...(projects ?? []).filter((candidate) => candidate.id !== project.id), project])
        onSuccess()
      },
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateProjectInput }) => trackerApi.projects.update(id, input),
      onSuccess: (project) => {
        client.setQueryData(projectsQuery.queryKey, (projects) => (projects ?? []).map((candidate) => (candidate.id === project.id ? project : candidate)))
        onSuccess()
      },
    }),
    remove: useMutation({ mutationFn: (id: Project['id']) => trackerApi.projects.remove(id), onSuccess }),
  }
}

/** Sprint writes refresh every sprint, chart and issue list (start re-dates; close and delete move members). */
export function useSprintMutations() {
  const client = useQueryClient()
  const onSuccess = () => void Promise.all([client.invalidateQueries({ queryKey: SPRINTS_KEY }), client.invalidateQueries({ queryKey: ISSUES_KEY }), client.invalidateQueries({ queryKey: ISSUE_KEY })])
  return {
    create: useMutation({
      mutationFn: (input: CreateSprintInput) => trackerApi.sprints.create(input),
      // The caller may navigate to the new sprint at once.
      onSuccess: (sprint) => {
        client.setQueryData(sprintQuery(sprint.id).queryKey, sprint)
        onSuccess()
      },
    }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateSprintInput }) => trackerApi.sprints.update(id, input), onSuccess }),
    start: useMutation({ mutationFn: (id: string) => trackerApi.sprints.start(id), onSuccess }),
    close: useMutation({ mutationFn: ({ id, moveIncompleteTo }: { id: string; moveIncompleteTo: string | null }) => trackerApi.sprints.close(id, moveIncompleteTo), onSuccess }),
    remove: useMutation({ mutationFn: (id: string) => trackerApi.sprints.remove(id), onSuccess }),
  }
}
