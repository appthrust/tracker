// The issue's live (or stalled) run: who is working, in which session, the
// latest report, how long since the last heartbeat and when the lease runs
// out, and "Stop work". Also the compact run entry of the timeline.
import { Square } from 'lucide-react'
import { useState } from 'react'
import { useCancelRun } from '../../api/queries'
import type { Run } from '../../api/tracker'
import { useText } from '../../i18n'
import { canCancelRun } from '../../model/agents'
import { Button, cn, ConfirmDialog, formatDateTime, formatRelative, Markdown, showToast } from '../../ui'
import { useReference } from '../issues/use-reference'
import { ActorAvatar, ActorName } from './actor'
import { RunLinks } from './request-card'
import { RunStateBadge, RunStateIcon, useNow } from './run-status'

export function RunBlock({ run }: { run: Run }) {
  const { t, locale } = useText()
  const { me } = useReference()
  const now = useNow(15_000)
  const cancel = useCancelRun()
  const [confirming, setConfirming] = useState(false)
  const stalled = run.state === 'stalled'
  /** A sentence carrying one relative time, with the absolute time as its tooltip. */
  const stamp = (iso: string, text: (time: string) => string) => (
    <time dateTime={iso} title={formatDateTime(iso, locale)}>
      {text(formatRelative(iso, locale, now))}
    </time>
  )
  return (
    <section
      aria-labelledby={`run-${run.id}`}
      className={cn('rounded-lg border px-4 py-3', stalled ? 'border-red-200 bg-bad-soft/60' : run.state === 'waiting' ? 'border-amber-200 bg-busy-soft/60' : 'border-accent-line bg-accent-soft/50')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`run-${run.id}`} className="sr-only">
          {t('tracker.run.title')}
        </h2>
        <ActorAvatar actor={run.agent} size="sm" />
        <ActorName actor={run.agent} className="text-[13px] font-semibold text-stone-900" />
        <RunStateBadge state={run.state} />
        {canCancelRun(run, me) ? (
          <Button size="sm" tone="secondary" icon={<Square />} className="ml-auto" onClick={() => (cancel.reset(), setConfirming(true))}>
            {t('tracker.run.cancel')}
          </Button>
        ) : null}
      </div>
      <dl className="mt-2.5 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="text-stone-500">{t('tracker.run.note')}</dt>
        <dd className="min-w-0 font-medium break-words text-stone-800">{run.note || <span className="font-normal text-stone-400">{t('tracker.run.noNote')}</span>}</dd>
        {run.session ? (
          <>
            <dt className="text-stone-500">{t('tracker.run.session')}</dt>
            <dd className="min-w-0 font-mono break-words text-stone-700">{run.session}</dd>
          </>
        ) : null}
      </dl>
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-stone-600">
        {stamp(run.startedAt, (time) => t('tracker.run.started', { time }))}
        {stamp(run.heartbeatAt, (time) => t('tracker.run.lastReport', { time }))}
      </p>
      <p className={cn('mt-1 flex items-start gap-1.5 text-[11px]', stalled ? 'font-medium text-bad-ink' : 'text-stone-500')}>
        {stalled ? <RunStateIcon state="stalled" className="mt-px size-3" /> : null}
        {stalled ? t('tracker.run.leaseExpired', { time: formatRelative(run.leaseExpiresAt, locale, now) }) : t('tracker.run.leaseLeft', { time: formatRelative(run.leaseExpiresAt, locale, now) })}
      </p>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('tracker.run.cancelTitle', { agent: run.agent.name, identifier: run.issue.identifier })}
        body={t('tracker.run.cancelBody')}
        confirmLabel={t('tracker.run.cancel')}
        tone="danger"
        pending={cancel.isPending}
        error={cancel.error}
        onConfirm={() =>
          cancel.mutate(run.id, {
            onSuccess: () => {
              setConfirming(false)
              showToast({ tone: 'success', title: t('tracker.run.canceled') })
            },
          })
        }
      />
    </section>
  )
}

/** A run in the timeline: started, and how it ended (with the report and links when it finished). */
export function RunTimelineEntry({ run }: { run: Run }) {
  const { t, locale } = useText()
  const { me, agents } = useReference()
  const ended = run.state === 'succeeded' || run.state === 'failed' || run.state === 'canceled'
  // `canceled_by:<sub>`: the signed-in person, an agent, or someone known only by subject.
  const canceledBy = run.reason?.startsWith('canceled_by:') ? run.reason.slice('canceled_by:'.length) : null
  const cancelerName = canceledBy === null ? '' : canceledBy === me.sub ? me.name : (agents.find((agent) => `agent:${agent.id}` === canceledBy)?.name ?? canceledBy)
  const reason = run.reason === 'reassigned' ? t('tracker.run.reason.reassigned') : run.reason === 'lease_expired' ? t('tracker.run.reason.lease_expired') : canceledBy !== null ? t('tracker.run.reason.canceledBy', { name: cancelerName }) : null
  return (
    <div className="flex items-start gap-2 pl-1 text-xs text-stone-500">
      <ActorAvatar actor={run.agent} />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span>{t(ended ? `tracker.run.timeline.${run.state as 'succeeded'}` : 'tracker.run.timeline.started', { agent: run.agent.name })}</span>
          <RunStateBadge state={run.state} />
          {reason ? <span>{reason}</span> : null}
          <span aria-hidden>·</span>
          <time dateTime={run.finishedAt ?? run.startedAt} title={formatDateTime(run.finishedAt ?? run.startedAt, locale)}>
            {formatRelative(run.finishedAt ?? run.startedAt, locale)}
          </time>
        </p>
        {run.state === 'succeeded' && run.summary ? (
          <div className="rounded-md border border-line bg-white px-3 py-2 text-stone-700">
            <Markdown source={run.summary} className="text-[13px] leading-relaxed [&>*+*]:mt-2" />
          </div>
        ) : null}
        {ended ? <RunLinks links={run.links} /> : null}
      </div>
    </div>
  )
}
