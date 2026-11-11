// Agent work at a glance: the run state as an icon plus words (never colour
// alone — working spins, waiting raises a hand, not responding shows a cut
// plug), the one-line "Astra · running tests · 3 分前" on cards and rows, and
// the open-request marker. Relative times re-render on their own clock so a
// card never claims "now" for ten minutes.
import { Ban, CheckCheck, Hand, LoaderCircle, MessageCircleQuestion, Unplug, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Run, RunState } from '../../api/tracker'
import { useText } from '../../i18n'
import { cn, formatDateTime, formatRelative } from '../../ui'
import { ActorAvatar } from './actor'

/** Re-renders every `intervalMs` (relative times on live work). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

const TONE: Record<RunState, string> = {
  running: 'bg-accent-soft text-accent-strong ring-accent-line',
  waiting: 'bg-busy-soft text-busy-ink ring-amber-200',
  stalled: 'bg-bad-soft text-bad-ink ring-red-200',
  succeeded: 'bg-stone-100 text-stone-600 ring-stone-200',
  failed: 'bg-stone-100 text-stone-600 ring-stone-200',
  canceled: 'bg-stone-100 text-stone-500 ring-stone-200',
}

export function RunStateIcon({ state, className }: { state: RunState; className?: string }) {
  const box = cn('size-3.5 shrink-0', className)
  switch (state) {
    case 'running':
      return <LoaderCircle aria-hidden className={cn(box, 'animate-spin [animation-duration:2.5s] motion-reduce:animate-none')} />
    case 'waiting':
      return <Hand aria-hidden className={box} />
    case 'stalled':
      return <Unplug aria-hidden className={box} />
    case 'succeeded':
      return <CheckCheck aria-hidden className={box} />
    case 'failed':
      return <XCircle aria-hidden className={box} />
    default:
      return <Ban aria-hidden className={box} />
  }
}

/** Icon and state word in the state's tone. */
export function RunStateBadge({ state, className }: { state: RunState; className?: string }) {
  const { t } = useText()
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium whitespace-nowrap ring-1 ring-inset', TONE[state], className)}>
      <RunStateIcon state={state} className="size-3" />
      {t(`tracker.run.state.${state}`)}
    </span>
  )
}

/** "[bot] Astra · running tests · 3 分前" under a card title (`variant="card"`), or the state badge with the agent, note and time on a dense row (the text from wide screens up; the full sentence is the tooltip and the screen-reader text). */
export function RunLine({ run, variant }: { run: Run; variant: 'card' | 'row' }) {
  const { t, locale } = useText()
  const now = useNow()
  const time = formatRelative(run.heartbeatAt, locale, now)
  const label = t('tracker.run.line', { agent: run.agent.name, state: t(`tracker.run.state.${run.state}`), note: run.note, time })
  if (variant === 'row') {
    return (
      <span className="inline-flex min-w-0 shrink items-center gap-1.5" title={label}>
        <RunStateBadge state={run.state} />
        <span aria-hidden className="hidden min-w-0 truncate text-xs text-stone-500 lg:inline">
          <span className="font-medium text-stone-700">{run.agent.name}</span>
          {run.note ? ` · ${run.note}` : ''} · {time}
        </span>
        <span className="sr-only">{label}</span>
      </span>
    )
  }
  return (
    <div className={cn('mt-2 rounded-md px-2 py-1.5 text-[11px] ring-1 ring-inset', TONE[run.state])}>
      <span className="sr-only">{label}</span>
      <div aria-hidden className="flex items-center gap-1.5">
        <ActorAvatar actor={run.agent} size="xs" />
        <span className="font-medium">{run.agent.name}</span>
        <span className="ml-auto inline-flex items-center gap-1 font-medium">
          <RunStateIcon state={run.state} className="size-3" />
          {t(`tracker.run.state.${run.state}`)}
        </span>
      </div>
      <p aria-hidden className="mt-1 flex min-w-0 items-baseline gap-1 text-stone-600">
        <span className="min-w-0 flex-1 truncate">{run.note || t('tracker.run.noNote')}</span>
        <time dateTime={run.heartbeatAt} title={formatDateTime(run.heartbeatAt, locale)} className="shrink-0 tabular-nums">
          {time}
        </time>
      </p>
    </div>
  )
}

/** "? 2" — open requests on the issue, with the count spelled out for screen readers. */
export function OpenRequestMarker({ count }: { count: number }) {
  const { t } = useText()
  if (count === 0) return null
  const label = t('tracker.run.openRequests', { count })
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-busy-soft px-1.5 py-px text-[11px] font-medium text-busy-ink ring-1 ring-amber-200 ring-inset" title={label}>
      <MessageCircleQuestion aria-hidden className="size-3" />
      <span aria-hidden className="tabular-nums">
        {count}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
