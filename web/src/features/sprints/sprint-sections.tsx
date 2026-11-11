// Grouping a list or board by sprint (`groupBy: sprint`): the section or lane
// heading (sprint name and state, dates, scope against the suggested
// commitment `averagePerWeek × lengthWeeks`, row count, "new issue in this
// sprint"), and moving a dragged row into another section, refused with a
// toast when the membership rules forbid it (an epic, a frozen closed
// sprint, a relative already there).
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, CircleDashed, Plus } from 'lucide-react'
import { velocityQuery } from '../../api/queries'
import type { IssueSummary, Sprint, SprintRef } from '../../api/tracker'
import { useText } from '../../i18n'
import { scopeOf, sprintChoiceProblem, suggestedCommitment, type SprintSection } from '../../model/sprints'
import { paths } from '../../routes/paths'
import { cn, HrefLink, showToast } from '../../ui'
import { useIssueEditor } from '../issues/properties'
import { useReference } from '../issues/use-reference'
import { SprintIcon, SprintStateBadge, sprintDates, unitValue } from './sprint-ui'

const isFullSprint = (sprint: Sprint | SprintRef): sprint is Sprint => 'current' in sprint

/** Moves `issue` into `section`'s sprint (null section sprint = backlog) unless the rules forbid it; `extra` joins the same PATCH (a board column's status). */
export function useSprintMove() {
  const { t } = useText()
  const { update } = useIssueEditor()
  return (issue: IssueSummary, section: SprintSection, extra: { statusId?: string } = {}) => {
    const target = section.sprint
    const moving = (target?.id ?? null) !== (issue.sprint?.id ?? null)
    if (moving) {
      const problem = sprintChoiceProblem(issue, target, section.issues)
      if (problem) {
        showToast({ tone: 'error', title: t('tracker.hierarchy.moveRefused', { identifier: issue.identifier }), detail: t(`tracker.sprint.problem.${problem}`) })
        return
      }
    }
    const input = { ...extra, ...(moving ? { sprintId: target?.id ?? null } : {}) }
    if (Object.keys(input).length > 0) update({ id: issue.id, input })
  }
}

export function SprintHeading({
  section,
  count,
  collapsed,
  onToggle,
  onNew,
  variant,
}: {
  section: SprintSection
  count: number
  collapsed: boolean
  onToggle: () => void
  onNew: () => void
  variant: 'section' | 'lane'
}) {
  const { t, locale } = useText()
  const { statusById } = useReference()
  const sprint = section.sprint
  const velocity = useQuery({ ...velocityQuery('points'), enabled: sprint !== null && sprint.state !== 'closed' })
  const name = sprint ? sprint.name : t('tracker.sprint.backlog')
  const scope = sprint && isFullSprint(sprint) ? sprint.current.scopePoints : scopeOf(section.issues, (statusId) => statusById.get(statusId)?.category, 'points')
  const suggested = sprint && isFullSprint(sprint) && sprint.state !== 'closed' ? suggestedCommitment(velocity.data?.averagePerWeek ?? null, sprint.lengthWeeks) : null
  const regionId = `group-rows-${section.key}`
  return (
    <h2
      className={cn(
        'z-[1] flex h-10 items-center gap-2 text-[13px] text-stone-700',
        variant === 'section'
          ? 'sticky top-0 border-y border-line bg-stone-50/95 pr-3 pl-2 backdrop-blur sm:pr-6 sm:pl-3'
          : 'sticky left-0 w-fit max-w-[100vw] px-2 sm:pl-4 md:max-w-[calc(100vw-14rem)]'
      )}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={regionId}
        aria-label={collapsed ? t('tracker.group.expand', { name }) : t('tracker.group.collapse', { name })}
        onClick={onToggle}
        className="flex size-6 shrink-0 items-center justify-center rounded text-stone-500 hover:bg-stone-200/60 hover:text-stone-900"
      >
        {collapsed ? <ChevronRight aria-hidden className="size-4" /> : <ChevronDown aria-hidden className="size-4" />}
      </button>
      {sprint ? (
        <>
          <SprintIcon state={sprint.state} />
          <HrefLink href={paths.sprint(sprint.id)} className="truncate font-medium text-stone-800 hover:text-stone-950 hover:underline">
            {sprint.name}
          </HrefLink>
          <SprintStateBadge state={sprint.state} />
          {isFullSprint(sprint) ? <span className="hidden shrink-0 text-xs text-stone-500 md:inline">{sprintDates(t, sprint, locale)}</span> : null}
        </>
      ) : (
        <>
          <CircleDashed aria-hidden className="size-3.5 shrink-0 text-stone-400" />
          <span className="font-medium text-stone-600">{name}</span>
        </>
      )}
      <span className="shrink-0 text-stone-400 tabular-nums">{count}</span>
      <span className="shrink-0 text-xs text-stone-500 tabular-nums" title={suggested !== null ? t('tracker.sprints.suggestedHint') : undefined}>
        {suggested !== null
          ? t('tracker.sprints.scopeOfSuggested', { scope: unitValue(t, scope, 'points'), suggested: unitValue(t, suggested, 'points') })
          : t('tracker.sprints.scopeValue', { scope: unitValue(t, scope, 'points') })}
      </span>
      {sprint?.state === 'closed' ? null : (
        <button
          type="button"
          aria-label={t('tracker.group.newIn', { name })}
          title={t('tracker.group.newIn', { name })}
          onClick={onNew}
          className="ml-auto flex size-6 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-200/60 hover:text-stone-700"
        >
          <Plus aria-hidden className="size-3.5" />
        </button>
      )}
    </h2>
  )
}
