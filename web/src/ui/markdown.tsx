// Article bodies are Markdown as written; the server never renders HTML.
// Every render goes through marked (GFM) and then DOMPurify, so a body can
// never inject script, event handlers or `javascript:` URLs into the page.
import DOMPurify, { type WindowLike } from 'dompurify'
import { marked } from 'marked'
import { useTracker } from 'react'
import { cn } from './cn'

/** Markdown → sanitized HTML against `window`'s DOM (a test passes a happy-dom window). */
export function createMarkdownRenderer(window: WindowLike): (markdown: string) => string {
  const purify = DOMPurify(window)
  purify.addHook('afterSanitizeAttributes', (node) => {
    // Links leave tracker in a new tab without handing it `window.opener`; images load only when scrolled to.
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (node.tagName === 'IMG') node.setAttribute('loading', 'lazy')
  })
  return (markdown) => purify.sanitize(marked.parse(markdown, { gfm: true, breaks: true, async: false }))
}

let browserRenderer: ((markdown: string) => string) | undefined

/** The rendered article body. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useTracker(() => {
    browserRenderer ??= createMarkdownRenderer(window)
    return browserRenderer(source)
  }, [source])
  return <div className={cn('tracker-prose', className)} dangerouslySetInnerHTML={{ __html: html }} />
}
