// Dev-only API mock: `bun src/dev/mock-server.ts` (or `bun run mock`). Serves
// the tracker contract (`/api/tracker/v1/*`, ./mock-tracker) and the app switcher's
// `GET /launcher` on one port; Vite proxies both here (vite.config.ts).
import { createMockLauncherHandler, mockLauncherEntries } from '@appthrust/app-launcher'
import { trackerRoutes } from './mock-tracker'

const port = Number(process.env.TRACKER_MOCK_PORT ?? 5236)
const launcher = createMockLauncherHandler(mockLauncherEntries('tracker'))

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url)
    return launcher(request) ?? (await trackerRoutes(request, url)) ?? Response.json({ error: 'not_found', message: `no mock for ${request.method} ${url.pathname}` }, { status: 404 })
  },
})

console.log(`tracker mock API on http://${server.hostname}:${server.port} (MOCK_ROLE=${process.env.MOCK_ROLE ?? 'Admin'})`)
