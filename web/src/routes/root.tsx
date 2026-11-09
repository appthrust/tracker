import { useQueryErrorResetBoundary, type QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, notFound, Outlet, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { FileQuestion } from 'lucide-react'
import { useEffect } from 'react'
import { isTrackerError } from '../api/tracker'
import { labelsQuery, meQuery, statusesQuery, viewsQuery, workspaceQuery } from '../api/queries'
import { useText } from '../i18n'
import { Shell } from '../shell/shell'
import { EmptyState, LinkButton, Loading, LoadFailed, useDocumentTitle } from '../ui'
import { paths } from './paths'

export type RouterContext = { queryClient: QueryClient }

/** Loader helper: an unknown issue or view renders the not-found page instead of an error. */
export function notFoundOn404(error: unknown): never {
  if (isTrackerError(error, 'not_found')) throw notFound()
  throw error
}

export function NotFound() {
  const { t } = useText()
  useDocumentTitle(t('tracker.notFound.title'))
  return (
    <div className="mx-auto max-w-md py-12">
      <EmptyState
        icon={<FileQuestion />}
        heading="h1"
        title={t('tracker.notFound.title')}
        body={t('tracker.notFound.body')}
        action={
          <LinkButton href={paths.home} tone="primary">
            {t('tracker.notFound.home')}
          </LinkButton>
        }
      />
    </div>
  )
}

/** In-page load failure (inside the shell). Retry re-runs the loaders and resets failed suspense queries. */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter()
  const queryErrorResetBoundary = useQueryErrorResetBoundary()
  useEffect(() => queryErrorResetBoundary.reset(), [queryErrorResetBoundary])
  if (isTrackerError(error, 'not_found')) return <NotFound />
  return (
    <div className="mx-auto max-w-xl py-8">
      <LoadFailed error={error} onRetry={() => void router.invalidate()} />
    </div>
  )
}

export function RoutePending() {
  return <Loading />
}

/** The caller could not be loaded: there is no shell yet. */
function RootError(props: ErrorComponentProps) {
  const { t } = useText()
  useDocumentTitle(t('tracker.common.loadFailed'))
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <RouteError {...props} />
    </div>
  )
}

function RootPending() {
  return (
    <div className="mx-auto flex max-w-xl justify-center px-6 py-24">
      <Loading />
    </div>
  )
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  // `GET /me` first (it proves the session), then the reference data every screen reads (workspace is created lazily on first read).
  beforeLoad: async ({ context }) => {
    await context.queryClient.ensureQueryData(meQuery)
    await context.queryClient.ensureQueryData(workspaceQuery)
    const client = context.queryClient
    await Promise.all([client.ensureQueryData(statusesQuery), client.ensureQueryData(labelsQuery), client.ensureQueryData(viewsQuery)])
  },
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  ),
  errorComponent: RootError,
  pendingComponent: RootPending,
  notFoundComponent: NotFound,
})
