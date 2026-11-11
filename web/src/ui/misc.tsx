import { Bot } from 'lucide-react'
import { useState } from 'react'
import type { ActorKind, Person } from '../api/tracker'
import { cn } from './cn'

const AVATAR_SIZE = { xs: 'size-5 text-[9px]', sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-16 text-xl' } as const
const AGENT_GLYPH = { xs: 'size-3', sm: 'size-3.5', md: 'size-4.5', lg: 'size-9' } as const

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
 * Directory image with the existing initials badge as its error/absence
 * fallback. An agent (`kind: 'agent'`) is never a photo: a dark rounded
 * square with a robot glyph, so it reads as "not a person" at any size.
 * `label` names the badge for tooltips and screen readers where no name sits beside it.
 */
export function Avatar({ person, size = 'md', label }: { person: Pick<Person, 'name' | 'avatarUrl'> & { kind?: ActorKind }; size?: keyof typeof AVATAR_SIZE; label?: string }) {
  const [failedUrl, setFailedUrl] = useState<string>()
  if (person.kind === 'agent') {
    return (
      <span
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
        title={label}
        className={cn('inline-flex shrink-0 items-center justify-center rounded-[28%] bg-stone-800 text-white ring-1 ring-stone-900/10 ring-inset', AVATAR_SIZE[size])}
      >
        <Bot aria-hidden className={AGENT_GLYPH[size]} strokeWidth={2.25} />
      </span>
    )
  }
  const showImage = person.avatarUrl && person.avatarUrl !== failedUrl
  return (
    <span
      aria-hidden={showImage || label ? undefined : true}
      role={label && !showImage ? 'img' : undefined}
      aria-label={label && !showImage ? label : undefined}
      title={label}
      className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-soft font-semibold text-accent-strong ring-1 ring-accent-line ring-inset', AVATAR_SIZE[size])}
    >
      {showImage ? (
        <img src={person.avatarUrl} alt={label ?? person.name} loading="lazy" className="size-full rounded-full object-cover" onError={() => setFailedUrl(person.avatarUrl)} />
      ) : initialsOf(person.name)}
    </span>
  )
}

/** Small neutral label next to a title or name (「あなた」, 「共有」). */
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

/** A keyboard hint (`C`, `⌘K`); decorative next to a labelled control, so screen readers skip it. */
export function Kbd({ children, className }: { children: string; className?: string }) {
  return (
    <kbd
      aria-hidden
      className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded border border-stone-200 bg-stone-50 px-1 font-sans text-[11px] leading-none font-medium text-stone-500', className)}
    >
      {children}
    </kbd>
  )
}

/** "2026年10月16日" / "Oct 16, 2026" for an ISO timestamp, in the reader's time zone. */
export function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso))
}

/** "2026/10/16 9:30" / "Oct 16, 2026, 9:30 AM" for tooltips next to a relative time. */
export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}

/** Largest unit first, in seconds. */
const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_629_800],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

/** "3 時間前" / "3 hours ago" in the largest whole unit; under a minute is "今" / "now". `now` is a test seam. */
export function formatRelative(iso: string, locale: string, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const seconds = (Date.parse(iso) - now) / 1000
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit)
  }
  return format.format(0, 'second')
}

/** "12 分" / "12 minutes", "3 時間" / "3 hours", "2 日" / "2 days" for a span of milliseconds (largest whole unit, at least a minute). */
export function formatDuration(ms: number, locale: string): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const [unit, value] = minutes >= 2 * 1440 ? (['day', Math.round(minutes / 1440)] as const) : minutes >= 120 ? (['hour', Math.round(minutes / 60)] as const) : (['minute', minutes] as const)
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value)
}
