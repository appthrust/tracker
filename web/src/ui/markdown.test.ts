import { describe, expect, test } from 'bun:test'
import type { WindowLike } from 'dompurify'
import { JSDOM } from 'jsdom'
import { excerptOf } from '../model/article'
import { createMarkdownRenderer } from './markdown'

// DOMPurify's documented server-side DOM; the browser passes its own `window`.
const render = createMarkdownRenderer(new JSDOM('').window as unknown as WindowLike)

describe('article Markdown rendering', () => {
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

describe('excerpt (domain.Excerpt)', () => {
  test('drops Markdown markers and link syntax and collapses whitespace', () => {
    expect(excerptOf('# 見出し\n\n- **太字** と `code`\n> 引用 [リンク](https://example.com) ![図](a.png)')).toBe('見出し 太字 と code 引用 リンク 図')
  })

  test('keeps at most 160 characters, counted as code points', () => {
    expect(Array.from(excerptOf('あ'.repeat(200)))).toHaveLength(160)
    expect(excerptOf('😀'.repeat(161))).toBe('😀'.repeat(160))
  })
})
