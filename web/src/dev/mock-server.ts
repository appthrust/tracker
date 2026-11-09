// Dev-only API mock: `bun src/dev/mock-server.ts` (or `bun run mock`). Serves
// the tracker contract (`/api/tracker/v1/*`, ./mock-tracker), the runtime
// `GET /config` (same shape as cmd/server) and the app switcher's
// `GET /launcher` on one port; Vite proxies all three here (vite.config.ts).
import { createMockLauncherHandler, mockLauncherEntries } from '@appthrust/app-launcher'
import { MOCK_WORKSPACE_ID, trackerRoutes } from './mock-tracker'

const port = Number(process.env.TRACKER_MOCK_PORT ?? 5236)
const launcher = createMockLauncherHandler(mockLauncherEntries('tracker'))

/** cmd/server's `GET /config`: project id, public URL and the Directory browser origin. */
function config(request: Request, url: URL): Response | undefined {
  if (request.method !== 'GET' || url.pathname !== '/config') return undefined
  return Response.json(
    {
      projectId: MOCK_WORKSPACE_ID,
      publicUrl: process.env.TRACKER_PUBLIC_URL ?? `http://127.0.0.1:${process.env.TRACKER_PORT ?? 5238}`,
      directoryUrl: process.env.TRACKER_DIRECTORY_PUBLIC_URL ?? 'https://directory.pj-mock.appthrust.ink',
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url)
    return (
      launcher(request) ??
      config(request, url) ??
      (await trackerRoutes(request, url)) ??
      Response.json({ error: 'not_found', message: `no mock for ${request.method} ${url.pathname}` }, { status: 404 })
    )
  },
})

console.log(`tracker mock API on http://${server.hostname}:${server.port} (MOCK_ROLE=${process.env.MOCK_ROLE ?? 'Admin'})`)
