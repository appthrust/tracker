import { describe, expect, test } from 'bun:test'
import { browseTab, closeAllTabs, closeTab, MAX_PANEL_TABS, NO_PANEL_TABS, openTab, parsePanelTabs, reconcileTabs, retitleTab, serializePanelTabs, type PanelTabs } from './panel-tabs'

/** Tabs in strip order; `recent` (most recently active first) defaults to the reverse, so the last tab is the active one. */
const state = (ids: string[], recent: string[] = [...ids].reverse()): PanelTabs => ({ tabs: ids.map((identifier) => ({ identifier })), recent })
const strip = (current: PanelTabs) => current.tabs.map((tab) => tab.identifier)
const active = (current: PanelTabs) => current.recent[0]
const openAll = (ids: string[]) => ids.reduce((current, id) => openTab(current, id), NO_PANEL_TABS)

describe('openTab', () => {
  test.each<[string, PanelTabs, string, string[], string[]]>([
    ['first tab', NO_PANEL_TABS, 'APT-1', ['APT-1'], ['APT-1']],
    ['appends right of the active last tab', state(['APT-1', 'APT-2']), 'APT-3', ['APT-1', 'APT-2', 'APT-3'], ['APT-3', 'APT-2', 'APT-1']],
    ['inserts right of an active middle tab', state(['APT-1', 'APT-2', 'APT-3'], ['APT-1', 'APT-3', 'APT-2']), 'APT-9', ['APT-1', 'APT-9', 'APT-2', 'APT-3'], ['APT-9', 'APT-1', 'APT-3', 'APT-2']],
    ['an open issue only becomes active', state(['APT-1', 'APT-2', 'APT-3']), 'APT-1', ['APT-1', 'APT-2', 'APT-3'], ['APT-1', 'APT-3', 'APT-2']],
    ['identifiers compare upper-cased', state(['APT-1', 'APT-2']), ' apt-1 ', ['APT-1', 'APT-2'], ['APT-1', 'APT-2']],
    ['a lower-case new issue is stored upper-cased', state(['APT-1']), 'apt-7', ['APT-1', 'APT-7'], ['APT-7', 'APT-1']],
  ])('%s', (_name, before, identifier, tabs, recent) => {
    const after = openTab(before, identifier)
    expect(strip(after)).toEqual(tabs)
    expect(after.recent).toEqual(recent)
  })

  test('opening the active tab again changes nothing', () => {
    const before = state(['APT-1', 'APT-2'])
    expect(openTab(before, 'apt-2')).toBe(before)
  })

  test('the clicked row title is kept, a missing title does not erase one', () => {
    const titled = openTab(NO_PANEL_TABS, 'APT-1', 'Login fails')
    expect(titled.tabs).toEqual([{ identifier: 'APT-1', title: 'Login fails' }])
    expect(openTab(openTab(titled, 'APT-2'), 'APT-1').tabs[0]).toEqual({ identifier: 'APT-1', title: 'Login fails' })
    expect(openTab(titled, 'APT-1', 'Login fails on Safari').tabs[0]).toEqual({ identifier: 'APT-1', title: 'Login fails on Safari' })
  })

  test(`a ${MAX_PANEL_TABS + 1}st tab evicts the least recently active one`, () => {
    const ids = Array.from({ length: MAX_PANEL_TABS }, (_, index) => `APT-${index + 1}`)
    // APT-1 was the first opened, but activating it again makes APT-2 the least recently active.
    const full = openTab(openAll(ids), 'APT-1')
    const after = openTab(full, 'APT-99')
    expect(after.tabs).toHaveLength(MAX_PANEL_TABS)
    expect(strip(after)).not.toContain('APT-2')
    expect(strip(after)).toContain('APT-1')
    expect(strip(after).indexOf('APT-99')).toBe(strip(after).indexOf('APT-1') + 1)
    expect(active(after)).toBe('APT-99')
    const next = openTab(after, 'APT-100')
    expect(strip(next)).not.toContain('APT-3')
    expect(strip(next)).toContain('APT-99')
  })

  test('the tab being opened is never the one evicted', () => {
    const ids = Array.from({ length: MAX_PANEL_TABS }, (_, index) => `APT-${index + 1}`)
    const after = openTab(openAll(ids), 'APT-50')
    expect(strip(after)).toContain('APT-50')
    expect(strip(after)).not.toContain('APT-1')
  })
})

describe('browseTab', () => {
  test.each<[string, PanelTabs, string, string, string[], string]>([
    ['replaces the active tab in place', state(['APT-1', 'APT-2', 'APT-3'], ['APT-2', 'APT-3', 'APT-1']), 'APT-2', 'APT-7', ['APT-1', 'APT-7', 'APT-3'], 'APT-7'],
    ['onto an open issue activates it and keeps the one browsed from', state(['APT-1', 'APT-2', 'APT-3'], ['APT-2', 'APT-3', 'APT-1']), 'APT-2', 'APT-3', ['APT-1', 'APT-2', 'APT-3'], 'APT-3'],
    ['case-insensitive on both sides', state(['APT-1', 'APT-2']), 'apt-2', 'apt-1', ['APT-1', 'APT-2'], 'APT-1'],
    ['onto itself changes nothing', state(['APT-1', 'APT-2']), 'APT-2', 'apt-2', ['APT-1', 'APT-2'], 'APT-2'],
    ['from an issue without a tab opens the target', state(['APT-1']), 'APT-5', 'APT-6', ['APT-1', 'APT-6'], 'APT-6'],
  ])('%s', (_name, before, from, to, tabs, current) => {
    const after = browseTab(before, from, to)
    expect(strip(after)).toEqual(tabs)
    expect(active(after)).toBe(current)
    expect([...after.recent].sort()).toEqual([...tabs].sort())
  })

  test('walking a list three steps keeps the tab count', () => {
    let current = openAll(['APT-1', 'APT-2', 'APT-3'])
    for (const [from, to] of [['APT-3', 'APT-4'], ['APT-4', 'APT-5'], ['APT-5', 'APT-6']] as const) current = browseTab(current, from, to)
    expect(strip(current)).toEqual(['APT-1', 'APT-2', 'APT-6'])
    expect(active(current)).toBe('APT-6')
  })

  test('walking across issues that are open closes none of them', () => {
    let current = openAll(['APT-1', 'APT-2', 'APT-3'])
    for (const [from, to] of [['APT-3', 'APT-1'], ['APT-1', 'APT-2'], ['APT-2', 'APT-3']] as const) current = browseTab(current, from, to)
    expect(strip(current)).toEqual(['APT-1', 'APT-2', 'APT-3'])
    expect(active(current)).toBe('APT-3')
  })

  test('the replaced tab takes the new title, not the old one', () => {
    const before = openTab(NO_PANEL_TABS, 'APT-1', 'Old')
    expect(browseTab(before, 'APT-1', 'APT-2').tabs).toEqual([{ identifier: 'APT-2' }])
    expect(browseTab(before, 'APT-1', 'APT-2', 'New').tabs).toEqual([{ identifier: 'APT-2', title: 'New' }])
  })
})

describe('closeTab', () => {
  // [name, tabs in strip order, active, closed, tabs after, active after]
  test.each<[string, string[], string, string, string[], string | undefined]>([
    ['active first: its right neighbour', ['APT-1', 'APT-2', 'APT-3'], 'APT-1', 'APT-1', ['APT-2', 'APT-3'], 'APT-2'],
    ['active middle: its right neighbour', ['APT-1', 'APT-2', 'APT-3'], 'APT-2', 'APT-2', ['APT-1', 'APT-3'], 'APT-3'],
    ['active last: its left neighbour', ['APT-1', 'APT-2', 'APT-3'], 'APT-3', 'APT-3', ['APT-1', 'APT-2'], 'APT-2'],
    ['only: none, the panel closes', ['APT-1'], 'APT-1', 'APT-1', [], undefined],
    ['a background tab: the active one stays', ['APT-1', 'APT-2', 'APT-3'], 'APT-3', 'APT-1', ['APT-2', 'APT-3'], 'APT-3'],
    ['a background tab right of the active one', ['APT-1', 'APT-2', 'APT-3'], 'APT-1', 'APT-2', ['APT-1', 'APT-3'], 'APT-1'],
    ['case-insensitive', ['APT-1', 'APT-2'], 'APT-1', 'apt-1', ['APT-2'], 'APT-2'],
  ])('%s', (_name, ids, current, identifier, tabs, next) => {
    const result = closeTab(openTab(state(ids), current), identifier)
    expect(strip(result.state)).toEqual(tabs)
    expect(result.next).toBe(next)
    expect<string | undefined>(result.state.recent[0]).toBe(next)
  })

  test('a tab that is not open: nothing changes', () => {
    const before = state(['APT-1', 'APT-2'])
    expect(closeTab(before, 'APT-9')).toEqual({ state: before, next: undefined })
  })

  test('the closed tab leaves the recency order, so it is never evicted later', () => {
    const { state: after } = closeTab(state(['APT-1', 'APT-2', 'APT-3']), 'APT-1')
    expect(after.recent).toEqual(['APT-3', 'APT-2'])
  })
})

test('closeAllTabs leaves no tab', () => {
  expect(closeAllTabs()).toEqual({ tabs: [], recent: [] })
})

describe('reconcileTabs', () => {
  test('no issue in the URL changes nothing', () => {
    const before = state(['APT-1'])
    expect(reconcileTabs(before, undefined)).toBe(before)
  })

  test('the URL issue already open becomes active (back/forward)', () => {
    const after = reconcileTabs(state(['APT-1', 'APT-2']), 'APT-1')
    expect(strip(after)).toEqual(['APT-1', 'APT-2'])
    expect(active(after)).toBe('APT-1')
  })

  test('an issue without a tab gets one (deep link, back to a closed issue, unknown issue)', () => {
    expect(strip(reconcileTabs(NO_PANEL_TABS, 'apt-9'))).toEqual(['APT-9'])
    const after = reconcileTabs(state(['APT-1', 'APT-2']), 'NOPE-404')
    expect(strip(after)).toEqual(['APT-1', 'APT-2', 'NOPE-404'])
    expect(active(after)).toBe('NOPE-404')
  })

  test('an active URL issue already in front is stable', () => {
    const before = state(['APT-1', 'APT-2'])
    expect(reconcileTabs(before, 'apt-2')).toBe(before)
  })
})

describe('retitleTab', () => {
  test('sets the title of one tab', () => {
    expect(retitleTab(state(['APT-1', 'APT-2']), 'apt-2', 'Crash').tabs).toEqual([{ identifier: 'APT-1' }, { identifier: 'APT-2', title: 'Crash' }])
  })

  test.each([
    ['an unknown tab', 'APT-9', 'Crash'],
    ['the same title', 'APT-1', 'Known'],
    ['an empty title', 'APT-1', ''],
  ])('%s changes nothing', (_name, identifier, title) => {
    const before = openTab(NO_PANEL_TABS, 'APT-1', 'Known')
    expect(retitleTab(before, identifier, title)).toBe(before)
  })

  test('keeps the order and the active tab', () => {
    const before = state(['APT-1', 'APT-2'], ['APT-1', 'APT-2'])
    expect(retitleTab(before, 'APT-2', 'x').recent).toEqual(['APT-1', 'APT-2'])
  })
})

describe('parsePanelTabs', () => {
  test('round-trips', () => {
    const before = openTab(openTab(openTab(NO_PANEL_TABS, 'APT-1', 'One'), 'APT-2'), 'APT-1')
    expect(parsePanelTabs(serializePanelTabs(before))).toEqual(before)
  })

  test.each([
    ['missing', null],
    ['empty', ''],
    ['not JSON', '{tabs:'],
    ['not an object', '42'],
    ['no tab list', '{"recent":["APT-1"]}'],
    ['no usable tab', '{"tabs":[{"identifier":3},null,"APT-1",{"identifier":"  "}]}'],
  ])('%s storage starts empty', (_name, raw) => {
    expect(parsePanelTabs(raw)).toEqual(NO_PANEL_TABS)
  })

  test('repairs case, duplicates, junk titles and a stale recency list', () => {
    const raw = JSON.stringify({ tabs: [{ identifier: 'apt-1', title: 7 }, { identifier: 'APT-2', title: 'Two' }, { identifier: 'Apt-1' }], recent: ['APT-9', 'apt-2', 'APT-2'] })
    expect(parsePanelTabs(raw)).toEqual({ tabs: [{ identifier: 'APT-1' }, { identifier: 'APT-2', title: 'Two' }], recent: ['APT-2', 'APT-1'] })
  })

  test(`keeps at most ${MAX_PANEL_TABS} tabs, dropping the least recently active`, () => {
    const ids = Array.from({ length: MAX_PANEL_TABS + 2 }, (_, index) => `APT-${index + 1}`)
    const parsed = parsePanelTabs(JSON.stringify({ tabs: ids.map((identifier) => ({ identifier })), recent: [...ids].reverse() }))
    expect(parsed.tabs).toHaveLength(MAX_PANEL_TABS)
    expect(strip(parsed)).toEqual(ids.slice(2))
  })
})
