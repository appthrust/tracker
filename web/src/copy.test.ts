import { createDashboardTranslator } from '@appthrust/platform-dashboard-i18n'
import { describe, expect, test } from 'bun:test'
import { catalogs } from './copy'
import { CATEGORIES, ISSUE_TYPES, PRIORITIES, SORTS, SURFACES } from './model/issues'

const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort()

describe('tracker copy catalogs', () => {
  const messages = catalogs.flatMap((catalog) => Object.entries(catalog))
  const ids = new Set(messages.map(([id]) => id))

  test('every message is namespaced, translated to Japanese and keeps its placeholders', () => {
    for (const [id, message] of messages) {
      expect(id.startsWith('tracker.')).toBe(true)
      const ja = message.translations.ja
      expect(ja, id).toBeTruthy()
      expect(placeholders(ja ?? ''), id).toEqual(placeholders(message.defaultMessage))
    }
  })

  test('every enum value the API can return has a name in both languages', () => {
    const expected = [
      ...ISSUE_TYPES.map((value) => `tracker.type.${value}`),
      ...PRIORITIES.map((value) => `tracker.priority.${value}`),
      ...CATEGORIES.flatMap((value) => [`tracker.category.${value}`, `tracker.category.${value}Hint`]),
      ...SURFACES.map((value) => `tracker.surface.${value}`),
      ...SORTS.map((value) => `tracker.sort.${value}`),
    ]
    for (const id of expected) expect(ids.has(id), id).toBe(true)
  })

  test('ids are unique, so both languages build a translator', () => {
    expect(ids.size).toBe(messages.length)
    const ja = createDashboardTranslator('ja', catalogs)
    const en = createDashboardTranslator('en', catalogs)
    expect(ja.t('tracker.nav.issues')).toBe('すべての課題')
    expect(en.t('tracker.nav.issues')).toBe('All issues')
    expect(ja.t('tracker.activity.status', { actor: 'Alex Chen', from: 'Todo', to: 'Done' })).toBe('Alex Chen が状態を Todo → Done に変更')
    expect(en.t('tracker.form.tooLong', { max: 200 })).toBe('Use at most 200 characters.')
  })
})
