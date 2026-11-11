// `/sprints`: the active sprint (goal, days left, remaining, a burndown
// thumbnail, Close), the velocity chart (committed vs completed per closed
// sprint with the per-week average and the points/issues toggle), the
// planned sprints (scope against the suggested commitment, Start), the
// closed ones (committed → completed), and "New sprint" (one or two weeks,
// the workspace setting first).
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CircleStop, Play, Plus } from 'lucide-react'
import { useState } from 'react'
import { burndownQuery, sprintsQuery, velocityQuery } from '../../api/queries'
import type { Sprint } from '../../api/tracker'
import { useText } from '../../i18n'
import { doneIn, remainingIn, scopeIn, suggestedCommitment } from '../../model/sprints'
import { listHref, paths } from '../../routes/paths'
import { Button, EmptyState, HrefLink, LinkButton, Loading, LoadFailed, useDocumentTitle } from '../../ui'
import { BurndownChart, VelocityChart } from './charts'
import { CloseSprintDialog, SprintFormDialog } from './dialogs'
import { SprintTiming, useSprintAction } from './sprint-page'
import { SprintIcon, SprintStateBadge, sprintDates, unitValue, UnitToggle, useChartUnit } from './sprint-ui'

export function SprintsPage() {
  const { t } = useText()
  useDocumentTitle(t('tracker.nav.sprints'))
  const sprints = useQuery(sprintsQuery)
  const [unit] = useChartUnit()
  const velocity = useQuery(velocityQuery(unit))
  const [creating, setCreating] = useState(false)
  const items = sprints.data ?? []
  const active = items.find((sprint) => sprint.state === 'active')
  const planned = items.filter((sprint) => sprint.state === 'planned')
  const closed = items.filter((sprint) => sprint.state === 'closed')
  const perWeek = velocity.data?.averagePerWeek ?? null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-white px-4 sm:px-6">
        <SprintIcon className="size-4" />
        <h1 className="min-w-0 shrink-0 truncate text-[15px] font-semibold text-stone-900">{t('tracker.nav.sprints')}</h1>
        <div className="ml-auto flex items-center gap-1.5">
          <UnitToggle />
          <Button tone="primary" size="sm" icon={<Plus />} onClick={() => setCreating(true)}>
            {t('tracker.sprints.new')}
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={sprints.isFetching || undefined}>
        <div className="mx-auto max-w-5xl space-y-8 px-4 py-6 sm:px-6">
          {sprints.isPending ? (
            <Loading />
          ) : sprints.isError ? (
            <LoadFailed error={sprints.error} onRetry={() => void sprints.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<SprintIcon />}
              title={t('tracker.sprints.emptyTitle')}
              body={t('tracker.sprints.emptyBody')}
              action={
                <Button tone="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                  {t('tracker.sprints.new')}
                </Button>
              }
            />
          ) : (
            <>
              <section aria-labelledby="sprints-active">
                <h2 id="sprints-active" className="mb-2 text-xs font-medium text-stone-500">
                  {t('tracker.sprints.active')}
                </h2>
                {active ? (
                  <ActiveSprintCard sprint={active} />
                ) : (
                  <p className="rounded-lg border border-dashed border-stone-300 bg-white px-4 py-5 text-sm text-stone-500">
                    <span className="font-medium text-stone-700">{t('tracker.sprints.noActive')}</span> {t('tracker.sprints.noActiveBody')}
                  </p>
                )}
              </section>

              <section aria-labelledby="sprints-velocity" className="rounded-lg border border-line bg-white px-4 py-4">
                <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 id="sprints-velocity" className="text-[13px] font-semibold text-stone-800">
                    {t('tracker.chart.velocity')}
                  </h2>
                  <p className="text-xs text-stone-500">{t('tracker.sprints.velocityLead')}</p>
                </div>
                {velocity.isPending ? <Loading /> : velocity.isError ? <LoadFailed error={velocity.error} onRetry={() => void velocity.refetch()} /> : <VelocityChart velocity={velocity.data} />}
              </section>

              <section aria-labelledby="sprints-planned">
                <h2 id="sprints-planned" className="mb-2 text-xs font-medium text-stone-500">
                  {t('tracker.sprints.planned')}
                </h2>
                {planned.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-stone-300 bg-white px-4 py-4 text-sm text-stone-500">{t('tracker.sprints.noPlanned')}</p>
                ) : (
                  <ul className="divide-y divide-stone-100 rounded-lg border border-line bg-white">
                    {planned.map((sprint) => (
                      <PlannedRow key={sprint.id} sprint={sprint} active={active} perWeek={perWeek} />
                    ))}
                  </ul>
                )}
              </section>

              {closed.length > 0 ? (
                <section aria-labelledby="sprints-closed">
                  <h2 id="sprints-closed" className="mb-2 text-xs font-medium text-stone-500">
                    {t('tracker.sprints.closed')}
                  </h2>
                  <ul className="divide-y divide-stone-100 rounded-lg border border-line bg-white">
                    {closed.map((sprint) => (
                      <ClosedRow key={sprint.id} sprint={sprint} />
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
      <SprintFormDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}

function ActiveSprintCard({ sprint }: { sprint: Sprint }) {
  const { t, locale } = useText()
  const [unit, setUnit] = useChartUnit()
  const burndown = useQuery(burndownQuery(sprint.id, unit))
  const [closing, setClosing] = useState(false)
  return (
    <article aria-labelledby={`sprint-card-${sprint.id}`} className="grid gap-4 rounded-lg border border-accent-line bg-white px-4 py-4 md:grid-cols-[1fr_16rem]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <SprintIcon state="active" className="size-4" />
          <h3 id={`sprint-card-${sprint.id}`} className="text-[15px] font-semibold text-stone-900">
            <HrefLink href={paths.sprint(sprint.id)} className="hover:underline">
              {sprint.name}
            </HrefLink>
          </h3>
          <SprintStateBadge state={sprint.state} />
          <span className="text-xs text-stone-500 tabular-nums">{sprintDates(t, sprint, locale)}</span>
          <span className="text-xs text-stone-600">
            <SprintTiming sprint={sprint} />
          </span>
        </div>
        <p className={sprint.goal ? 'mt-1.5 text-[13px] text-stone-800' : 'mt-1.5 text-[13px] text-stone-400'}>
          <span className="sr-only">{t('tracker.sprints.goal')}: </span>
          {sprint.goal || t('tracker.sprints.noGoal')}
        </p>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <div>
            <dt className="text-[11px] text-stone-500">{t('tracker.chart.remaining')}</dt>
            <dd className="text-2xl font-semibold text-stone-900 tabular-nums">{unitValue(t, remainingIn(sprint.current, unit), unit)}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-stone-500">{t('tracker.chart.completed')}</dt>
            <dd className="text-lg font-semibold text-stone-700 tabular-nums">{t('tracker.sprints.ofScope', { done: doneIn(sprint.current, unit), scope: unitValue(t, scopeIn(sprint.current, unit), unit) })}</dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <LinkButton size="sm" href={paths.sprint(sprint.id)} icon={<ArrowRight />}>
            {t('tracker.sprints.open')}
          </LinkButton>
          <LinkButton size="sm" tone="ghost" href={paths.currentSprint}>
            {t('tracker.nav.currentSprint')}
          </LinkButton>
          <Button size="sm" tone="ghost" icon={<CircleStop />} onClick={() => setClosing(true)}>
            {t('tracker.sprints.close')}
          </Button>
        </div>
      </div>
      <div className="min-w-0 self-center">
        {burndown.isPending ? <Loading /> : burndown.isError ? <LoadFailed error={burndown.error} onRetry={() => void burndown.refetch()} /> : <BurndownChart burndown={burndown.data} sprint={sprint} variant="thumb" onUseIssues={() => setUnit('issues')} />}
        <p className="mt-1 text-[11px] text-stone-500">{t('tracker.chart.burndown')}</p>
      </div>
      <CloseSprintDialog sprint={sprint} open={closing} onOpenChange={setClosing} />
    </article>
  )
}

function PlannedRow({ sprint, active, perWeek }: { sprint: Sprint; active: Sprint | undefined; perWeek: number | null }) {
  const { t, locale } = useText()
  const [unit] = useChartUnit()
  const { start, starting } = useSprintAction()
  const suggested = suggestedCommitment(perWeek, sprint.lengthWeeks)
  return (
    <li className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <SprintIcon state="planned" />
      <HrefLink href={paths.sprint(sprint.id)} className="min-w-0 truncate text-[13px] font-medium text-stone-800 hover:underline">
        {sprint.name}
      </HrefLink>
      <span className="text-xs text-stone-500 tabular-nums">{sprintDates(t, sprint, locale)}</span>
      <span className="text-xs text-stone-400">{sprint.lengthWeeks === 1 ? t('tracker.sprints.oneWeek') : t('tracker.sprints.twoWeeks')}</span>
      <span className="ml-auto text-xs text-stone-600 tabular-nums" title={suggested !== null ? t('tracker.sprints.suggestedHint') : undefined}>
        {suggested !== null
          ? t('tracker.sprints.scopeOfSuggested', { scope: unitValue(t, scopeIn(sprint.current, unit), unit), suggested: unitValue(t, suggested, unit) })
          : t('tracker.sprints.scopeValue', { scope: unitValue(t, scopeIn(sprint.current, unit), unit) })}
      </span>
      <LinkButton size="sm" tone="ghost" href={listHref(paths.home, { group: 'sprint' })}>
        {t('tracker.sprints.plan')}
      </LinkButton>
      <Button size="sm" icon={<Play />} loading={starting} disabled={Boolean(active)} title={active ? t('tracker.sprints.startBlocked', { name: active.name }) : undefined} onClick={() => start(sprint)}>
        {t('tracker.sprints.start')}
      </Button>
    </li>
  )
}

function ClosedRow({ sprint }: { sprint: Sprint }) {
  const { t, locale } = useText()
  const [unit] = useChartUnit()
  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <SprintIcon state="closed" />
      <HrefLink href={paths.sprint(sprint.id)} className="min-w-0 truncate text-[13px] text-stone-800 hover:underline">
        {sprint.name}
      </HrefLink>
      <span className="text-xs text-stone-500 tabular-nums">{sprintDates(t, sprint, locale)}</span>
      <span className="ml-auto text-xs text-stone-600 tabular-nums">
        {t('tracker.sprints.committedCompleted', { committed: unitValue(t, sprint.commitment ? scopeIn(sprint.commitment, unit) : 0, unit), completed: unitValue(t, doneIn(sprint.current, unit), unit) })}
      </span>
    </li>
  )
}
