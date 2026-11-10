import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Avatar } from './misc'

test('avatar renders a lazy image, falls back on error or absence, and retries a new version', async () => {
  const dom = new JSDOM('<div id="root"></div>')
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true }
  const saved = Object.getOwnPropertyDescriptors(globalThis)
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  const person = { name: '森 怜峰', avatarUrl: '/api/tracker/v1/people/person-1/avatar?v=1' }
  try {
    await act(() => root.render(<Avatar person={person} size="xs" />))
    const image = container.querySelector('img')!
    expect(image.getAttribute('src')).toBe(person.avatarUrl)
    expect(image.alt).toBe(person.name)
    expect(image.getAttribute('loading')).toBe('lazy')
    expect(container.firstElementChild?.className).toContain('size-5')
    expect(container.firstElementChild?.className).toContain('rounded-full')
    expect(image.closest('[aria-hidden="true"]')).toBeNull()
    await act(() => image.dispatchEvent(new dom.window.Event('error')))
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('森')
    await act(() => root.render(<Avatar person={{ ...person, avatarUrl: `${person.avatarUrl}2` }} size="xs" />))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`${person.avatarUrl}2`)
    await act(() => root.render(<Avatar person={{ name: 'Ada Lovelace' }} size="sm" />))
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('AL')
    expect(container.firstElementChild?.className).toContain('size-6')
  } finally {
    await act(() => root.unmount())
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
