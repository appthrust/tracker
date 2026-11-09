import { describe, expect, test } from 'bun:test'
import type { WindowLike } from 'dompurify'
import { JSDOM } from 'jsdom'
import { createMarkdownRenderer } from './markdown'

// DOMPurify's documented server-side DOM; the browser passes its own `window`.
const render = createMarkdownRenderer(new JSDOM('').window as unknown as WindowLike)

describe('issue Markdown rendering', () => {
  test('renders GFM and strips script, event handlers and javascript: URLs', () => {
    const html = render(
      ['# 見出し', '**太字** と `code`', '- 一つ目\n- 二つ目', '<script>alert(1)</script>', '<img src="x.png" onerror="alert(2)">', '[危険](javascript:alert(3))'].join('\n\n')
    )
    expect(html).toContain('<h1>見出し</h1>')
    expect(html).toContain('<strong>太字</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<li>一つ目</li>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('<p><a>危険</a></p>')
    expect(html).toContain('loading="lazy"')
  })

  test('links open in a new tab without the opener', () => {
    const html = render('[ガイド](https://example.com/guide)')
    expect(html).toContain('href="https://example.com/guide"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})
