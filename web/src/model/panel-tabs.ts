// The issue side panel's tabs (design/README.md "Issue panel tabs"): the
// issues a person opened, in strip order, each with the title last seen.
// The active issue is the URL's `?issue=`, not part of this state; `recent`
// only orders the tabs by when they were last active, so the 21st open evicts
// the least recently active one and a new tab lands right of the last active.
// Identifiers compare upper-cased. Pure: storage and navigation live in
// features/issues/use-panel-tabs.ts.

export const MAX_PANEL_TABS = 20

export type PanelTab = { identifier: string; title?: string }

export type PanelTabs = {
  /** Strip order, left to right; no duplicates. */
  tabs: PanelTab[]
  /** The same identifiers, most recently active first. */
  recent: string[]
}

export const NO_PANEL_TABS: PanelTabs = { tabs: [], recent: [] }

export const normalizeIdentifier = (identifier: string) => identifier.trim().toUpperCase()

const indexOf = (state: PanelTabs, identifier: string) => state.tabs.findIndex((tab) => tab.identifier === identifier)

const touch = (recent: string[], identifier: string) => [identifier, ...recent.filter((id) => id !== identifier)]

/** Drops the least recently active tabs beyond the cap, never `keep` (the one just opened). */
function evict(state: PanelTabs, keep: string): PanelTabs {
  let { tabs, recent } = state
  while (tabs.length > MAX_PANEL_TABS) {
    const victim = [...recent].reverse().find((id) => id !== keep)
    if (victim === undefined) break
    tabs = tabs.filter((tab) => tab.identifier !== victim)
    recent = recent.filter((id) => id !== victim)
  }
  return tabs === state.tabs ? state : { tabs, recent }
}

/** Open: the issue becomes the most recently active; a new tab goes right of the previously active one. */
export function openTab(state: PanelTabs, identifier: string, title?: string): PanelTabs {
  const id = normalizeIdentifier(identifier)
  const at = indexOf(state, id)
  if (at !== -1) {
    const retitled = title !== undefined && title !== '' && title !== state.tabs[at]!.title
    if (!retitled && state.recent[0] === id) return state
    return { tabs: retitled ? state.tabs.map((tab, index) => (index === at ? { ...tab, title } : tab)) : state.tabs, recent: touch(state.recent, id) }
  }
  const previous = state.recent[0] === undefined ? -1 : indexOf(state, state.recent[0])
  const insertAt = previous === -1 ? state.tabs.length : previous + 1
  const tab: PanelTab = title ? { identifier: id, title } : { identifier: id }
  const tabs = [...state.tabs.slice(0, insertAt), tab, ...state.tabs.slice(insertAt)]
  return evict({ tabs, recent: touch(state.recent, id) }, id)
}

/**
 * Browse: the tab showing `from` shows `to` instead, in place. When `to`
 * already has a tab, that tab becomes active and `from`'s stays: walking a
 * list across issues a person opened must not close them.
 */
export function browseTab(state: PanelTabs, from: string, to: string, title?: string): PanelTabs {
  const source = normalizeIdentifier(from)
  const target = normalizeIdentifier(to)
  const at = indexOf(state, source)
  if (at === -1 || source === target || indexOf(state, target) !== -1) return openTab(state, target, title)
  const tab: PanelTab = title ? { identifier: target, title } : { identifier: target }
  return {
    tabs: state.tabs.map((current, index) => (index === at ? tab : current)),
    recent: touch(
      state.recent.filter((id) => id !== source),
      target
    ),
  }
}

/**
 * Close one tab. Closing the active tab (the most recently active one)
 * activates the one to its right, else the one to its left; closing any other
 * tab leaves the active one alone. `next` is the tab active afterwards:
 * undefined when none is left (or the tab was not open).
 */
export function closeTab(state: PanelTabs, identifier: string): { state: PanelTabs; next: string | undefined } {
  const id = normalizeIdentifier(identifier)
  const at = indexOf(state, id)
  if (at === -1) return { state, next: undefined }
  const tabs = state.tabs.filter((tab) => tab.identifier !== id)
  const recent = state.recent.filter((current) => current !== id)
  const current = state.recent[0]
  if (current !== undefined && current !== id && indexOf(state, current) !== -1) return { state: { tabs, recent }, next: current }
  const next = (tabs[at] ?? tabs[at - 1])?.identifier
  return { state: { tabs, recent: next === undefined ? recent : touch(recent, next) }, next }
}

/** Close the panel: every tab closes. */
export function closeAllTabs(): PanelTabs {
  return NO_PANEL_TABS
}

/** The URL's issue always has a tab (deep link, reload, back/forward) and is the most recently active. */
export function reconcileTabs(state: PanelTabs, urlIssue: string | undefined): PanelTabs {
  return urlIssue ? openTab(state, urlIssue) : state
}

/** Remembers the title seen for a tab; other tabs and the order are untouched. */
export function retitleTab(state: PanelTabs, identifier: string, title: string): PanelTabs {
  const id = normalizeIdentifier(identifier)
  const at = indexOf(state, id)
  if (at === -1 || !title || state.tabs[at]!.title === title) return state
  return { ...state, tabs: state.tabs.map((tab, index) => (index === at ? { ...tab, title } : tab)) }
}

/** Stored tabs as JSON; anything missing, malformed or over the cap is repaired, never trusted. */
export function parsePanelTabs(raw: string | null): PanelTabs {
  if (!raw) return NO_PANEL_TABS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return NO_PANEL_TABS
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as PanelTabs).tabs)) return NO_PANEL_TABS
  const tabs: PanelTab[] = []
  for (const entry of (parsed as PanelTabs).tabs as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const { identifier, title } = entry as Record<string, unknown>
    if (typeof identifier !== 'string' || !identifier.trim()) continue
    const id = normalizeIdentifier(identifier)
    if (tabs.some((tab) => tab.identifier === id)) continue
    tabs.push(typeof title === 'string' && title ? { identifier: id, title } : { identifier: id })
  }
  const stored = Array.isArray((parsed as PanelTabs).recent) ? ((parsed as PanelTabs).recent as unknown[]) : []
  const known = new Set(tabs.map((tab) => tab.identifier))
  const recent: string[] = []
  for (const id of stored) if (typeof id === 'string' && known.has(normalizeIdentifier(id)) && !recent.includes(normalizeIdentifier(id))) recent.push(normalizeIdentifier(id))
  // Tabs the recency list forgot count as the least recently active, in strip order.
  for (const tab of tabs) if (!recent.includes(tab.identifier)) recent.push(tab.identifier)
  const state = { tabs, recent }
  return recent[0] === undefined ? NO_PANEL_TABS : evict(state, recent[0])
}

export function serializePanelTabs(state: PanelTabs): string {
  return JSON.stringify(state)
}
