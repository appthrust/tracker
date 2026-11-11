// `/sprints/<id>`: the sprint's header (state, dates, days left, goal, the
// state action — Start for a planned sprint, Close for the active one — edit
// and, for Admins, delete while planned), its totals and full burndown with
// the unit toggle, then the issue list/board filtered to `{ sprint: [id] }`
// (issues-page.tsx), where the work under a member story is listed with it.
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, CircleStop, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import { burndownQuery, sprintQuery, sprintsQuery, useSprintMutations, velocityQuery } from '../../api/queries'
import type { Sprint } from '../../api/tracker'
import { useText } from '../../i18n'
import { dayInZone, daysBetween, daysLeft, doneIn, remainingIn, scopeIn, suggestedCommitment } from '../../model/sprints'
import { paths, type ListSearch } from '../../routes/paths'
import { Button, cn, errorDetail, errorMessageId, Loading, LoadFailed, showToast } from '../../ui'
import { IssuesPage } from '../issues/issues-page'
import { useReference } from '../issues/use-reference'
import { BurndownChart } from './charts'
import { CloseSprintDialog, DeleteSprintDialog, SprintFormDialog } from './dialogs'
import { formatDay, SprintStateBadge, unitValue, UnitToggle, useChartUnit, useToday } from './sprint-ui'

export function SprintPage({ sprintId, search }: { sprintId: string; search: ListSearch }) {
  const { data: sprint } = useSuspenseQuery(sprintQuery(sprintId))
  return <IssuesPage page={{ kind: 'sprint', sprint }} path={paths.sprint(sprint.id)} search={search} top={<SprintSummary sprint={sprint} />} />
}

/** "残り 5 日", "3 日後に開始", "終了日を過ぎています", or the close date. */
export function SprintTiming({ sprint }: { sprint: Sprint }) {
  const { t, locale } = useText()
  const today = useToday()
  const { workspace } = useReference()
  if (sprint.state === 'closed') return <span>{t('tracker.sprints.closedOn', { date: formatDay(dayInZone(sprint.closedAt!, workspace.timezone), locale) })}</span>
  if (sprint.state === 'planned') return <span>{today < sprint.startsOn ? t('tracker.sprints.startsIn', { count: daysBetween(today, sprint.startsOn) }) : t('tracker.sprints.readyToStart')}</span>
  return today > sprint.endsOn ? <span className="font-medium text-busy-ink">{t('tracker.sprints.overdue')}</span> : <span>{t('tracker.sprints.daysLeft', { count: daysLeft(sprint, today) })}</span>
}

/** Start or close, with the result in a toast (409: another sprint is active, or the sprint moved on meanwhile). */
export function useSprintAction() {
  const { t } = useText()
  const { start } = useSprintMutations()
  const failed = (error: unknown) => {
    const known = errorMessageId(error)
    showToast({ tone: 'error', title: t('tracker.common.actionFailed'), detail: [known ? t(known) : undefined, errorDetail(error)].filter(Boolean).join(' ') || undefined })
  }
  return {
    start: (sprint: Sprint) => start.mutate(sprint.id, { onSuccess: (started) => showToast({ tone: 'success', title: t('tracker.sprints.started', { name: started.name }) }), onError: failed }),
    starting: start.isPending,
  }
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-24">
      <dt className="text-[11px] text-stone-500">{label}</dt>
      <dd className="text-lg font-semibold text-stone-900 tabular-nums" title={hint}>
        {value}
      </dd>
    </div>
  )
}

function SprintSummary({ sprint }: { sprint: Sprint }) {
  const { t, locale } = useText()
  const navigate = useNavigate()
  const { me } = useReference()
  const [unit, setUnit] = useChartUnit()
  const [chartOpen, setChartOpen] = useState(true)
  const [editing, setEditing] = useState(false)
  const [closing, setClosing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const burndown = useQuery({ ...burndownQuery(sprint.id, unit), enabled: chartOpen })
  const velocity = useQuery({ ...velocityQuery(unit), enabled: sprint.state !== 'closed' })
  const active = useQuery(sprintsQuery).data?.find((candidate) => candidate.state === 'active')
  const { start, starting } = useSprintAction()
  const suggested = sprint.state !== 'closed' ? suggestedCommitment(velocity.data?.averagePerWeek ?? null, sprint.lengthWeeks) : null
  const blockedBy = sprint.state === 'planned' && active && active.id !== sprint.id ? active : undefined
  return (
    <section aria-label={t('tracker.sprints.summary', { name: sprint.name })} className="shrink-0 border-b border-line bg-white px-4 py-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SprintStateBadge state={sprint.state} />
        <span className="text-[13px] text-stone-700 tabular-nums">{t('tracker.sprints.dates', { start: formatDay(sprint.startsOn, locale, true), end: formatDay(sprint.endsOn, locale, true) })}</span>
        <span className="text-xs text-stone-500">{sprint.lengthWeeks === 1 ? t('tracker.sprints.oneWeek') : t('tracker.sprints.twoWeeks')}</span>
        <span className="text-xs text-stone-600">
          <SprintTiming sprint={sprint} />
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {sprint.state === 'planned' ? (
            <Button size="sm" tone="primary" icon={<Play />} loading={starting} disabled={Boolean(blockedBy)} title={blockedBy ? t('tracker.sprints.startBlocked', { name: blockedBy.name }) : undefined} onClick={() => start(sprint)}>
              {t('tracker.sprints.start')}
            </Button>
          ) : null}
          {sprint.state === 'active' ? (
            <Button size="sm" tone="primary" icon={<CircleStop />} onClick={() => setClosing(true)}>
              {t('tracker.sprints.close')}
            </Button>
          ) : null}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" aria-label={t('tracker.sprints.menu')} title={t('tracker.sprints.menu')} className="flex size-8 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900">
                <MoreHorizontal aria-hidden className="size-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-40 rounded-lg border border-line bg-white p-1 shadow-lg animate-pop-in">
                <DropdownMenu.Item onSelect={() => setEditing(true)} className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-stone-700 outline-none data-[highlighted]:bg-stone-100">
                  <Pencil aria-hidden className="size-3.5" />
                  {t('tracker.sprints.edit')}
                </DropdownMenu.Item>
                {me.isAdmin && sprint.state === 'planned' ? (
                  <DropdownMenu.Item onSelect={() => setDeleting(true)} className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-bad-ink outline-none data-[highlighted]:bg-bad-soft">
                    <Trash2 aria-hidden className="size-3.5" />
                    {t('tracker.sprints.delete')}
                  </DropdownMenu.Item>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
      <p className={cn('mt-1.5 max-w-3xl text-[13px] whitespace-pre-wrap', sprint.goal ? 'text-stone-800' : 'text-stone-400')}>
        <span className="sr-only">{t('tracker.sprints.goal')}: </span>
        {sprint.goal || t('tracker.sprints.noGoal')}
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-x-6 gap-y-2">
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          <Stat label={t('tracker.chart.scope')} value={unitValue(t, scopeIn(sprint.current, unit), unit)} />
          <Stat label={t('tracker.chart.completed')} value={unitValue(t, doneIn(sprint.current, unit), unit)} />
          <Stat label={t('tracker.chart.remaining')} value={unitValue(t, remainingIn(sprint.current, unit), unit)} />
          {sprint.commitment ? <Stat label={t('tracker.chart.committed')} value={unitValue(t, scopeIn(sprint.commitment, unit), unit)} /> : null}
          {suggested !== null ? <Stat label={t('tracker.sprints.suggested')} value={unitValue(t, suggested, unit)} hint={t('tracker.sprints.suggestedHint')} /> : null}
        </dl>
        <div className="ml-auto flex items-center gap-2">
          <UnitToggle />
          <button
            type="button"
            aria-expanded={chartOpen}
            onClick={() => setChartOpen((open) => !open)}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-stone-600 hover:bg-stone-100 hover:text-stone-900"
          >
            {chartOpen ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
            {t('tracker.chart.burndown')}
          </button>
        </div>
      </div>
      {chartOpen ? (
        <div className="mt-2 max-w-4xl">
          {burndown.isPending ? (
            <Loading />
          ) : burndown.isError ? (
            <LoadFailed error={burndown.error} onRetry={() => void burndown.refetch()} />
          ) : (
            <BurndownChart burndown={burndown.data} sprint={sprint} onUseIssues={() => setUnit('issues')} />
          )}
        </div>
      ) : null}
      <SprintFormDialog sprint={sprint} open={editing} onOpenChange={setEditing} />
      <CloseSprintDialog sprint={sprint} open={closing} onOpenChange={setClosing} />
      <DeleteSprintDialog sprint={sprint} open={deleting} onOpenChange={setDeleting} onDeleted={() => void navigate({ to: paths.sprints } as never)} />
    </section>
  )
}
