// The issue panel's tabs for a page that hosts the panel (lists, board,
// sprints, views, inbox). The URL's `issue` is the active tab; the tab list
// is the store's (model/panel-tabs.ts, persisted per browser tab). Every
// action updates the list first and then the URL through the host's
// `setIssue`: opening, activating and closing push a history entry (back
// returns to the previously active issue), browsing replaces it.
import { useCallback, useLayoutEffect } from 'react'
import { browseTab, closeAllTabs, closeTab, normalizeIdentifier, openTab, reconcileTabs, retitleTab, type PanelTab } from '../../model/panel-tabs'
import { setPanelTabs, uiStore, useUi } from '../ui-state'

/** Changes the URL's `issue` (undefined removes it and the panel closes). */
export type SetIssue = (issue: string | undefined, replace: boolean) => void

/** What a host page hands to IssuePanel. `active` is the URL's issue, upper-cased. */
export type PanelTabsController = {
  tabs: PanelTab[]
  active: string | undefined
  open: (issue: PanelTab) => void
  browse: (issue: PanelTab) => void
  close: (identifier: string) => string | undefined
  closeAll: () => void
  activate: (identifier: string) => void
  retitle: (identifier: string, title: string) => void
}

export function usePanelTabs(urlIssue: string | undefined, setIssue: SetIssue): PanelTabsController {
  const tabs = useUi((state) => state.panelTabs.tabs)
  const active = urlIssue ? normalizeIdentifier(urlIssue) : undefined

  // The URL's issue always has a tab: a deep link, a reload, back/forward to a closed one. Before paint, so the strip never shows without it.
  useLayoutEffect(() => {
    if (urlIssue) setPanelTabs((state) => reconcileTabs(state, urlIssue))
  }, [urlIssue])

  /** Open (click or Enter on a row or card, a link): activates its tab, adding one right of the active tab when it has none. */
  const open = useCallback(
    (issue: PanelTab) => {
      setPanelTabs((state) => openTab(state, issue.identifier, issue.title))
      setIssue(issue.identifier, false)
    },
    [setIssue]
  )

  /**
   * Browse (J/K, arrows with the panel open): the active tab shows `issue`
   * instead; without a panel it is an open. The tab browsed from is the
   * store's most recent one, which a key repeat faster than the URL update
   * has already moved on.
   */
  const browse = useCallback(
    (issue: PanelTab) => {
      if (!active) return open(issue)
      setPanelTabs((state) => browseTab(state, state.recent[0] ?? active, issue.identifier, issue.title))
      setIssue(issue.identifier, true)
    },
    [active, open, setIssue]
  )

  /** Closes one tab. Closing the active one activates its right neighbour (else left) and the panel closes with the last tab; closing another leaves the URL alone. Returns the tab now active. */
  const close = useCallback(
    (identifier: string) => {
      const { state, next } = closeTab(uiStore.state.panelTabs, identifier)
      setPanelTabs(() => state)
      if (next !== active) setIssue(next, false)
      return next
    },
    [active, setIssue]
  )

  /** The panel's ×: every tab closes. */
  const closeAll = useCallback(() => {
    setPanelTabs(closeAllTabs)
    setIssue(undefined, false)
  }, [setIssue])

  const activate = useCallback((identifier: string) => open({ identifier }), [open])

  const retitle = useCallback((identifier: string, title: string) => setPanelTabs((state) => retitleTab(state, identifier, title)), [])

  return { tabs, active, open, browse, close, closeAll, activate, retitle }
}
