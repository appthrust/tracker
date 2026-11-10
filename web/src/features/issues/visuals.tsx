// Linear-style glyphs: status circle (shape by category, tint by status color),
// priority bars, type marks (epic and story stand apart from work items),
// epic/story progress and label/project dots, plus the palette color radio
// group used wherever a label, status or project gets a color. Glyphs are
// decorative; every use sits next to the visible or screen-reader name.
import { BookMarked, Bug, CircleDashed, Lightbulb, ListTodo, TriangleAlert, Zap } from 'lucide-react'
import type { IssueType, LabelColor, Priority, Progress, Status } from '../../api/tracker'
import { useText } from '../../i18n'
import { cn } from '../../ui'

/** Static class strings so Tailwind sees every palette color. */
export const COLOR_DOT: Record<LabelColor, string> = {
  gray: 'bg-stone-400',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  yellow: 'bg-amber-400',
  green: 'bg-emerald-500',
  teal: 'bg-teal-500',
  blue: 'bg-blue-500',
  indigo: 'bg-indigo-500',
  purple: 'bg-violet-500',
  pink: 'bg-pink-500',
}

const COLOR_TEXT: Record<LabelColor, string> = {
  gray: 'text-stone-400',
  red: 'text-red-500',
  orange: 'text-orange-500',
  yellow: 'text-amber-500',
  green: 'text-emerald-600',
  teal: 'text-teal-600',
  blue: 'text-blue-500',
  indigo: 'text-indigo-500',
  purple: 'text-violet-500',
  pink: 'text-pink-500',
}

export const LABEL_COLORS = Object.keys(COLOR_DOT) as LabelColor[]

const asColor = (color: string): LabelColor => (color in COLOR_DOT ? (color as LabelColor) : 'gray')

export function ColorDot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2.5 shrink-0 rounded-full', COLOR_DOT[asColor(color)], className)} />
}

/** The palette as a radio group of swatches. */
export function ColorSelect({ value, onChange, label }: { value: string; onChange: (color: LabelColor) => void; label: string }) {
  const { t } = useText()
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {LABEL_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={t(`tracker.color.${color}`)}
          title={t(`tracker.color.${color}`)}
          onClick={() => onChange(color)}
          className={cn('flex size-6 items-center justify-center rounded-full', value === color ? 'ring-2 ring-stone-900 ring-offset-1' : 'hover:ring-1 hover:ring-stone-300')}
        >
          <span aria-hidden className={cn('size-3.5 rounded-full', COLOR_DOT[color])} />
        </button>
      ))}
    </div>
  )
}

/** Backlog: dashed ring; unstarted: ring; started: half pie; completed: filled check; canceled: filled cross. */
export function StatusIcon({ status, className }: { status: Pick<Status, 'category' | 'color'> | undefined; className?: string }) {
  const tone = COLOR_TEXT[asColor(status?.color ?? 'gray')]
  const box = cn('size-3.5 shrink-0', tone, className)
  switch (status?.category) {
    case 'backlog':
      return <CircleDashed aria-hidden className={box} strokeWidth={2.25} />
    case 'started':
      return (
        <svg aria-hidden viewBox="0 0 14 14" className={box}>
          <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="currentColor" />
        </svg>
      )
    case 'completed':
      return (
        <svg aria-hidden viewBox="0 0 14 14" className={box}>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" />
          <path d="M4.2 7.2 6.1 9 9.8 5.2" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'canceled':
      return (
        <svg aria-hidden viewBox="0 0 14 14" className={box}>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" />
          <path d="M5 5 9 9M9 5 5 9" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    default:
      return (
        <svg aria-hidden viewBox="0 0 14 14" className={box}>
          <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )
  }
}

/** Urgent: filled warning; high/medium/low: 3/2/1 of three bars; none: three dashes. */
export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  if (priority === 'urgent') return <TriangleAlert aria-hidden className={cn('size-3.5 shrink-0 text-orange-600', className)} strokeWidth={2.5} />
  const level = { high: 3, medium: 2, low: 1, none: 0 }[priority]
  return (
    <svg aria-hidden viewBox="0 0 14 14" className={cn('size-3.5 shrink-0 text-stone-500', className)}>
      {[0, 1, 2].map((bar) =>
        priority === 'none' ? (
          <rect key={bar} x={1.5 + bar * 4} y={6.5} width={3} height={1.5} rx={0.5} fill="currentColor" opacity={0.6} />
        ) : (
          <rect key={bar} x={1.5 + bar * 4} y={10 - bar * 3} width={3} height={2.5 + bar * 3} rx={0.75} fill="currentColor" opacity={bar < level ? 1 : 0.25} />
        )
      )}
    </svg>
  )
}

export function TypeIcon({ type, className }: { type: IssueType; className?: string }) {
  const box = cn('size-3.5 shrink-0', className)
  if (type === 'epic') return <Zap aria-hidden className={cn(box, 'fill-violet-100 text-violet-600')} />
  if (type === 'story') return <BookMarked aria-hidden className={cn(box, 'text-teal-600')} />
  if (type === 'bug') return <Bug aria-hidden className={cn(box, 'text-red-500')} />
  if (type === 'feature') return <Lightbulb aria-hidden className={cn(box, 'text-amber-500')} />
  return <ListTodo aria-hidden className={cn(box, 'text-stone-500')} />
}

/** Completed share of an epic's or story's work items, with `completed/total` beside the bar. */
export function ProgressBar({ progress, className }: { progress: Progress; className?: string }) {
  const { t } = useText()
  const label = t('tracker.progress.label', { completed: progress.completed, total: progress.total })
  const percent = progress.total === 0 ? 0 : Math.round((progress.completed / progress.total) * 100)
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5', className)} title={label}>
      <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed} className="block h-1.5 w-14 overflow-hidden rounded-full bg-stone-200">
        <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${percent}%` }} />
      </span>
      <span aria-hidden className="text-[11px] text-stone-500 tabular-nums">
        {progress.completed}/{progress.total}
      </span>
    </span>
  )
}
