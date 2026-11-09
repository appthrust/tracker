import { cn } from './cn'

const AVATAR_SIZE = { sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-16 text-xl' } as const

/**
 * Up to two initials: the first letters of the first two words of a Latin name
 * ("Ada Lovelace" → "AL"), else the first character ("山田 太郎" → "山").
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = Array.from(words[0] ?? '')[0]
  if (!first) return '?'
  const second = Array.from(words[1] ?? '')[0]
  return /^[A-Za-z]$/.test(first) && second && /^[A-Za-z]$/.test(second) ? `${first}${second}`.toUpperCase() : first.toUpperCase()
}

/**
 * An author's initials in a neutral circle. No image is fetched (a Directory
 * photo is cross-origin and would hit the OIDC edge). Decorative; the name is
 * always shown next to it.
 */
export function Avatar({ name, size = 'md' }: { name: string; size?: keyof typeof AVATAR_SIZE }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-strong ring-1 ring-accent-line ring-inset', AVATAR_SIZE[size])}
    >
      {initialsOf(name)}
    </span>
  )
}

/** Small neutral label next to a title or name (「下書き」, 「あなた」). */
export function Badge({ children, tone = 'neutral' }: { children: string; tone?: 'neutral' | 'accent' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset',
        tone === 'accent' ? 'bg-accent-soft text-accent-strong ring-accent-line' : 'bg-stone-100 text-stone-600 ring-stone-200'
      )}
    >
      {children}
    </span>
  )
}

/** "2026年10月16日" / "Oct 16, 2026" for an ISO timestamp, in the reader's time zone. */
export function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso))
}
