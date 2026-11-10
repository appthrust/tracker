// Read-model loading and writes (React Query). Every query is a
// `queryOptions()` / `infiniteQueryOptions()` factory so route loaders
// (`ensureQueryData`) and components share one key and fetcher. Freshness:
// every query refetches every 15 s while the tab is visible and on window
// focus (no push in v1). Issue edits (status, priority, assignee, labels, project, …)
// are optimistic: lists and the open issue change at once and roll back on
// failure.
import { infiniteQueryOptions, QueryClient, queryOptions, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { compactFilter } from '../model/issues'
import {
  trackerApi,
  TrackerApiError,
  type CreateIssueInput,
  type CreateProjectInput,
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
  type StatusCategory,
  type UpdateIssueInput,
  type UpdateProjectInput,
  type UpdateViewInput,
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

export const meQuery = queryOptions({ queryKey: [...TRACKER_KEY, 'me'], queryFn: () => trackerApi.me(), staleTime: 60_000 })
export const workspaceQuery = queryOptions({ queryKey: [...TRACKER_KEY, 'workspace'], queryFn: () => trackerApi.workspace.get() })
export const statusesQuery = queryOptions({ queryKey: [...TRACKER_KEY, 'statuses'], queryFn: () => trackerApi.statuses.list() })
export const labelsQuery = queryOptions({ queryKey: [...TRACKER_KEY, 'labels'], queryFn: () => trackerApi.labels.list() })
export const viewsQuery = queryOptions({ queryKey: [...TRACKER_KEY, 'views'], queryFn: () => trackerApi.views.list() })
/** Every project, archived included: issues keep showing an archived project's name; pickers offer active ones only. */
export const projectsQuery = queryOptions({ queryKey: [...TRACKER_KEY, 'projects'], queryFn: () => trackerApi.projects.list({ includeArchived: true }) })

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

/** The summary/issue as it will look after `input`; `assignee` is the picked person for display. */
export function applyIssuePatch<T extends IssueSummary>(issue: T, input: UpdateIssueInput, assignee?: Person | null): T {
  const next: T = { ...issue }
  if (input.title !== undefined) next.title = input.title
  if (input.type !== undefined) next.type = input.type
  if (input.priority !== undefined) next.priority = input.priority
  if (input.statusId !== undefined) next.statusId = input.statusId
  if (input.labelIds !== undefined) next.labelIds = input.labelIds
  if (input.dueOn !== undefined) next.dueOn = input.dueOn
  if (input.report !== undefined) next.report = input.report
  if (input.projectId !== undefined) next.projectId = input.projectId
  if (input.assigneeSub !== undefined) next.assignee = input.assigneeSub === null ? null : (assignee ?? issue.assignee)
  if ('description' in next && input.description !== undefined) (next as unknown as Issue).description = input.description
  return next
}

type IssueLists = InfiniteData<IssuePage, string | null>

/** Writes `update` into every cached list page and the cached issue detail with this id. */
function patchCaches(client: QueryClient, id: string, update: <T extends IssueSummary>(issue: T) => T) {
  client.setQueriesData<IssueLists>({ queryKey: ISSUES_KEY }, (data) =>
    data && 'pages' in data ? { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.id === id ? update(item) : item)) })) } : data
  )
  client.setQueriesData<Issue>({ queryKey: ISSUE_KEY }, (data) => (data && data.id === id ? update(data) : data))
}

export type IssueEdit = { id: string; input: UpdateIssueInput; assignee?: Person | null }

export function useUpdateIssue() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: IssueEdit) => trackerApi.issues.update(id, input),
    onMutate: async ({ id, input, assignee }) => {
      await Promise.all([client.cancelQueries({ queryKey: ISSUES_KEY }), client.cancelQueries({ queryKey: ISSUE_KEY })])
      const lists = client.getQueriesData<IssueLists>({ queryKey: ISSUES_KEY })
      const details = client.getQueriesData<Issue>({ queryKey: ISSUE_KEY })
      patchCaches(client, id, (issue) => applyIssuePatch(issue, input, assignee))
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
    },
  })
}

/** Edits several issues at once (palette on a multi-selection); each is optimistic on its own. */
export function useUpdateIssues() {
  const update = useUpdateIssue()
  return {
    ...update,
    run: (ids: string[], input: UpdateIssueInput, assignee?: Person | null) => Promise.allSettled(ids.map((id) => update.mutateAsync({ id, input, assignee }))),
  }
}

const invalidateIssues = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: ISSUES_KEY }),
    client.invalidateQueries({ queryKey: ISSUE_KEY }),
    client.invalidateQueries({ queryKey: workspaceQuery.queryKey }),
    client.invalidateQueries({ queryKey: projectsQuery.queryKey }),
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
    mutationFn: (input: { key?: string; name?: string }) => trackerApi.workspace.update(input),
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
