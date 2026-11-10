// Page routes. `/settings` redirects to its first tab; list-like routes keep
// their state in the query (routes/paths.ts).
import { useSuspenseQuery } from '@tanstack/react-query'
import { createRoute, notFound, redirect } from '@tanstack/react-router'
import { issueQuery, viewsQuery } from '../api/queries'
import { IssuePage } from '../features/issues/issue-detail'
import { IssuesPage } from '../features/issues/issues-page'
import { ReportPage } from '../features/report/report-page'
import { SettingsPage, type SettingsTab } from '../features/settings/settings-page'
import { paths, validateListSearch } from './paths'
import { notFoundOn404, rootRoute } from './root'

export const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: validateListSearch,
  component: function ListRoute() {
    return <IssuesPage page={{ kind: 'all' }} path={paths.home} search={listRoute.useSearch()} />
  },
})

export const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/board',
  validateSearch: validateListSearch,
  component: function BoardRoute() {
    return <IssuesPage page={{ kind: 'board' }} path={paths.board} search={boardRoute.useSearch()} />
  },
})

export const reportedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reported',
  validateSearch: validateListSearch,
  component: function ReportedRoute() {
    return <IssuesPage page={{ kind: 'reported' }} path={paths.reported} search={reportedRoute.useSearch()} />
  },
})

export const viewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/views/$viewId',
  validateSearch: validateListSearch,
  loader: async ({ context, params }) => {
    // A view created elsewhere (another tab, a teammate's shared view) is not in the cache yet.
    const cached = await context.queryClient.ensureQueryData(viewsQuery)
    const views = cached.some((view) => view.id === params.viewId) ? cached : await context.queryClient.fetchQuery(viewsQuery)
    if (!views.some((view) => view.id === params.viewId)) throw notFound()
  },
  component: function ViewRoute() {
    const { viewId } = viewRoute.useParams()
    const { data: views } = useSuspenseQuery(viewsQuery)
    const view = views.find((candidate) => candidate.id === viewId)
    if (!view) throw notFound()
    // Remount per view so selection and focus never leak between views.
    return <IssuesPage key={view.id} page={{ kind: 'view', view }} path={paths.view(view.id)} search={viewRoute.useSearch()} />
  },
})

export const issueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/issues/$identifier',
  loader: ({ context, params }) => context.queryClient.ensureQueryData(issueQuery(params.identifier)).catch(notFoundOn404),
  component: function IssueRoute() {
    const { identifier } = issueRoute.useParams()
    return <IssuePage key={identifier.toUpperCase()} identifier={identifier} />
  },
})

export const reportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/report',
  validateSearch: (search: Record<string, unknown>): { version?: string } => (typeof search.version === 'string' && search.version ? { version: search.version.slice(0, 100) } : {}),
  component: function ReportRoute() {
    return <ReportPage version={reportRoute.useSearch().version} />
  },
})

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: () => {
    throw redirect({ to: paths.settingsWorkspace } as never)
  },
})

const settingsTab = (tab: SettingsTab) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/settings/${tab}`,
    component: () => <SettingsPage tab={tab} />,
  })

export const routeTree = rootRoute.addChildren([
  listRoute,
  boardRoute,
  reportedRoute,
  viewRoute,
  issueRoute,
  reportRoute,
  settingsRoute,
  settingsTab('workspace'),
  settingsTab('statuses'),
  settingsTab('labels'),
  settingsTab('projects'),
])
