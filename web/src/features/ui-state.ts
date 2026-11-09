// App-wide UI state outside the URL: which overlay is open and which issues
// keyboard commands act on. List/board/detail screens publish the issues on
// screen (`context`), the focused one (J/K) and the X-selected ones; the
// command palette edits the selection, else the focused issue.
import { Store, useSelector } from '@tanstack/react-store'
import type { IssueSummary } from '../api/tracker'

type UiState = {
  palette: boolean
  /** Open "new issue" dialog with its defaults, or null. */
  newIssue: { statusId?: string } | null
  context: IssueSummary[]
  focusedId: string | null
  selectedIds: string[]
}

export const uiStore = new Store<UiState>({ palette: false, newIssue: null, context: [], focusedId: null, selectedIds: [] })

export function useUi<T>(select: (state: UiState) => T): T {
  return useSelector(uiStore, select)
}

export function setUi(patch: Partial<UiState> | ((state: UiState) => Partial<UiState>)) {
  uiStore.setState((state) => ({ ...state, ...(typeof patch === 'function' ? patch(state) : patch) }))
}

/** The issues a command applies to: the X-selection when there is one, else the focused issue. */
export function commandTargets(state: UiState): IssueSummary[] {
  const ids = state.selectedIds.length > 0 ? state.selectedIds : state.focusedId ? [state.focusedId] : []
  return ids.map((id) => state.context.find((issue) => issue.id === id)).filter((issue): issue is IssueSummary => issue !== undefined)
}

/** True for keys typed into a field, where single-letter shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (target as HTMLInputElement).type
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
}

/** True while focus sits in a dialog or popover, which own their keys. */
export function insideOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null
}

/** Plain single-key shortcut: no Ctrl/Meta/Alt, not typing, not inside an overlay. */
export function isPlainShortcut(event: KeyboardEvent): boolean {
  return !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && !isTypingTarget(event.target) && !insideOverlay(event.target)
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'
