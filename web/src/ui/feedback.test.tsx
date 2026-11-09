import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TrackerApiError } from '../api/tracker'
import { I18nProvider } from '../i18n'
import { ActionError, LoadFailed } from './feedback'

const render = (node: ReactNode, language: 'ja' | 'en' = 'ja') => renderToStaticMarkup(<I18nProvider language={language}>{node}</I18nProvider>)

describe('tracker error feedback', () => {
  test('a 409 conflict explains itself and keeps the server reason as a hint', () => {
    const error = new TrackerApiError(409, { error: 'conflict', message: 'move the issues in this status first' })
    const html = render(<ActionError error={error} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('現在のデータと矛盾するため変更できません。')
    expect(html).toContain('move the issues in this status first')
    expect(render(<ActionError error={error} />, 'en')).toContain('This conflicts with the current data.')
  })

  test('an invalid 400 lists the field issues under the localized summary; unknown errors stay generic', () => {
    const invalid = render(
      <ActionError error={new TrackerApiError(400, { error: 'invalid', message: 'invalid body', issues: [{ path: 'report.surface', message: 'surface must be one of dashboard, …' }] })} />
    )
    expect(invalid).toContain('入力内容を確認してください。')
    expect(invalid).toContain('report.surface: surface must be one of dashboard, …')
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
