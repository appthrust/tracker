import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TrackerApiError } from '../api/tracker'
import { I18nProvider } from '../i18n'
import { ActionError, LoadFailed } from './feedback'

const render = (node: ReactNode, language: 'ja' | 'en' = 'ja') => renderToStaticMarkup(<I18nProvider language={language}>{node}</I18nProvider>)

describe('tracker error feedback', () => {
  test('following yourself explains the 400 instead of a generic failure', () => {
    const error = new TrackerApiError(400, { error: 'self_follow', message: 'You cannot follow yourself' })
    const html = render(<ActionError error={error} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('自分自身はフォローできません。')
    expect(html).not.toContain('You cannot follow yourself')
    expect(render(<ActionError error={error} />, 'en')).toContain("You can&#x27;t follow yourself.")
  })

  test('an invalid_request keeps the server detail under the localized summary; unknown errors stay generic', () => {
    const invalid = render(<ActionError error={new TrackerApiError(400, { error: 'invalid_request', message: 'title must be at most 120 characters' })} />)
    expect(invalid).toContain('入力内容を確認してください。')
    expect(invalid).toContain('title must be at most 120 characters')
    expect(render(<ActionError error={new Error('boom')} />)).toContain('操作を完了できませんでした')
  })

  test('a 401 load failure offers no retry; a store outage explains itself and offers one', () => {
    const denied = render(<LoadFailed error={new TrackerApiError(401, { error: 'unauthenticated', message: '' })} onRetry={() => {}} />)
    expect(denied).toContain('このアカウントでは tracker を使えません')
    expect(denied).not.toContain('<button')
    const store = render(<LoadFailed error={new TrackerApiError(503, { error: 'tracker_store_unavailable', message: 'database unreachable' })} onRetry={() => {}} />)
    expect(store).toContain('もう一度読み込む')
    expect(store).toContain('データベースに一時的につながりません')
  })
})
