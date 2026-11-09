// Every tracker URL. List-like pages (`/`, `/board`, `/views/<id>`) carry their
// state in the query: `filter` (API.md Filter as JSON), `sort`, `layout`
// (views only) and `issue` (the identifier open in the side panel).
import type { Filter, Sort, ViewLayout } from '../api/tracker'
import { compactFilter, SORTS } from '../model/issues'

export type ListSearch = { filter?: string; sort?: string; layout?: string; issue?: string }

export const paths = {
  home: '/',
  board: '/board',
  view: (viewId: string) => `/views/${encodeURIComponent(viewId)}`,
  issue: (identifier: string) => `/issues/${encodeURIComponent(identifier)}`,
  report: '/report',
  settings: '/settings',
  settingsWorkspace: '/settings/workspace',
  settingsStatuses: '/settings/statuses',
  settingsLabels: '/settings/labels',
}

/** Keeps only the string params a list page understands. */
export function validateListSearch(search: Record<string, unknown>): ListSearch {
  const out: ListSearch = {}
  for (const key of ['filter', 'sort', 'layout', 'issue'] as const) {
    if (typeof search[key] === 'string' && search[key]) out[key] = search[key] as string
  }
  return out
}

/** The URL `filter` param as a Filter; malformed JSON is no filter. */
export function parseFilterParam(value: string | undefined): Filter | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? compactFilter(parsed as Filter) : undefined
  } catch {
    return undefined
  }
}

export function filterParam(filter: Filter): string | undefined {
  const compact = compactFilter(filter)
  return Object.keys(compact).length > 0 ? JSON.stringify(compact) : undefined
}

export function parseSortParam(value: string | undefined): Sort | undefined {
  return SORTS.includes(value as Sort) ? (value as Sort) : undefined
}

export function parseLayoutParam(value: string | undefined): ViewLayout | undefined {
  return value === 'list' || value === 'board' ? value : undefined
}

/** `path?filter=…&sort=…` for a link that opens a list with this state. */
export function listHref(path: string, { filter, sort }: { filter?: Filter; sort?: Sort } = {}): string {
  const search = new URLSearchParams()
  const encoded = filter ? filterParam(filter) : undefined
  if (encoded) search.set('filter', encoded)
  if (sort) search.set('sort', sort)
  const text = search.toString()
  return text ? `${path}?${text}` : path
}
