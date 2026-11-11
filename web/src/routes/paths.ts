// Every tracker URL. List-like pages (`/`, `/board`, `/reported`,
// `/current-sprint`, `/sprints/<id>`, `/views/<id>`) carry their state in the
// query: `filter` (API.md Filter as JSON), `sort`, `layout` (built-in views,
// sprints and views), `group` (`epic`, `story` or `sprint`; absent = the
// page's default, `none` overrides a view's grouping), `issue` (the
// identifier open in the side panel) and, on `/`, `/board`, `/reported` and
// `/epics`, `project` — the project scope (a project id or `none`; absent =
// all projects), kept out of `filter` so a scoped link stays readable.
import type { Filter, GroupBy, Sort, ViewLayout } from '../api/tracker'
import { compactFilter, GROUP_BYS, SORTS } from '../model/issues'

export type ListSearch = { filter?: string; sort?: string; layout?: string; group?: string; issue?: string; project?: string }

export const paths = {
  home: '/',
  board: '/board',
  /** Built-in "Reported by me" view (issues-page.tsx `REPORTED_VIEW`); not a stored View. */
  reported: '/reported',
  /** Epics overview: every epic with its stories and progress. */
  epics: '/epics',
  /** Sprints overview: the active sprint, planned and closed ones, velocity. */
  sprints: '/sprints',
  sprint: (sprintId: string) => `/sprints/${encodeURIComponent(sprintId)}`,
  /** Built-in "Current sprint" view (issues-page.tsx `CURRENT_SPRINT_VIEW`): the active sprint's board; not a stored View. */
  currentSprint: '/current-sprint',
  /** Built-in "Agents at work" view (issues-page.tsx `AT_WORK_VIEW`): issues with a live run; not a stored View. */
  atWork: '/agents-at-work',
  /** Built-in "Waiting for people" view (issues-page.tsx `WAITING_VIEW`): issues with open requests; not a stored View. */
  waiting: '/waiting-for-people',
  /** The caller's queue of requests, answers and mentions (`?issue=` opens the side panel). */
  inbox: '/inbox',
  view: (viewId: string) => `/views/${encodeURIComponent(viewId)}`,
  issue: (identifier: string) => `/issues/${encodeURIComponent(identifier)}`,
  report: '/report',
  settings: '/settings',
  settingsWorkspace: '/settings/workspace',
  settingsStatuses: '/settings/statuses',
  settingsLabels: '/settings/labels',
  settingsProjects: '/settings/projects',
  settingsAgents: '/settings/agents',
}

/** Keeps only the string params a list page understands. */
export function validateListSearch(search: Record<string, unknown>): ListSearch {
  const out: ListSearch = {}
  for (const key of ['filter', 'sort', 'layout', 'group', 'issue', 'project'] as const) {
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

export function parseGroupParam(value: string | undefined): GroupBy | undefined {
  return GROUP_BYS.includes(value as GroupBy) ? (value as GroupBy) : undefined
}

/** `path?filter=…&sort=…&group=…&project=…` for a link that opens a list with this state. */
export function listHref(path: string, { filter, sort, group, project }: { filter?: Filter; sort?: Sort; group?: GroupBy; project?: string | null } = {}): string {
  const search = new URLSearchParams()
  const encoded = filter ? filterParam(filter) : undefined
  if (encoded) search.set('filter', encoded)
  if (sort) search.set('sort', sort)
  if (group) search.set('group', group)
  if (project) search.set('project', project)
  const text = search.toString()
  return text ? `${path}?${text}` : path
}
