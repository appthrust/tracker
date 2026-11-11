// Issue property pickers (status, priority, assignee, labels, type, project,
// estimate, sprint) used as compact chips on list rows and board cards and as
// full rows in the detail sidebar. Every pick is an optimistic PATCH; a
// refused edit rolls back and says so in a toast. An epic takes neither an
// estimate nor a sprint; sprints the membership rules forbid for this issue
// (closed, a relative already there, its own sprint closed) are shown
// disabled with the reason.
import { useQuery } from '@tanstack/react-query'
import { CircleDashed, Ruler, Tag, UserRound } from 'lucide-react'
import { useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'
import { allIssuesQuery, childrenQuery, peopleQuery, sprintsQuery, useUpdateIssue, type IssueEdit } from '../../api/queries'
import type { Actor, Agent, Issue, IssueSummary, IssueType, Person, Priority, Size, Sprint } from '../../api/tracker'
import { useText, type Translate } from '../../i18n'
import { agentSub, isAgent } from '../../model/agents'
import { canBeType, ISSUE_TYPES, parentLevelOf, PRIORITIES } from '../../model/issues'
import { SIZES, sprintChoiceProblem } from '../../model/sprints'
import { Avatar, cn, errorDetail, errorMessageId, Picker, showToast, type PickerOption } from '../../ui'
import { ActorAvatar, AgentTag } from '../agents/actor'
import { EstimateBadge, SprintIcon } from '../sprints/sprint-ui'
import { ProjectPicker, ProjectPill, ProjectSwatch } from './projects'
import { useReference } from './use-reference'
import { ColorDot, PriorityIcon, StatusIcon, TypeIcon } from './visuals'

export type ChipVariant = 'chip' | 'row'

/** `update(edit)`: optimistic PATCH that reports a refusal in a toast. */
export function useIssueEditor() {
  const { t } = useText()
  const mutation = useUpdateIssue()
  const update = (edit: IssueEdit) =>
    mutation.mutate(edit, {
      onError: (error) => {
        const known = errorMessageId(error)
        showToast({ tone: 'error', title: t('tracker.issue.saveFailed'), detail: [known ? t(known) : undefined, errorDetail(error)].filter(Boolean).join(' ') || undefined })
      },
    })
  return { update, pending: mutation.isPending }
}

const CHIP = 'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-stone-600 hover:bg-stone-100 hover:text-stone-900 data-[state=open]:bg-stone-100'
const ROW = 'flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-stone-800 hover:bg-stone-100 data-[state=open]:bg-stone-100'
/** Popover trigger: Radix passes its props (open toggle, aria-expanded, ref) through; clicks never reach the row underneath. */
function Trigger({
  variant,
  label,
  children,
  className,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant: ChipVariant; label: string; children: ReactNode; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(variant === 'chip' ? CHIP : ROW, className)}
      {...rest}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.(event)
      }}
    >
      {children}
    </button>
  )
}

export function StatusPicker({ issue, variant = 'chip' }: { issue: IssueSummary; variant?: ChipVariant }) {
  const { t } = useText()
  const { statuses, statusById } = useReference()
  const { update } = useIssueEditor()
  const current = statusById.get(issue.statusId)
  const options: PickerOption[] = statuses.map((status, index) => ({ value: status.id, label: status.name, icon: <StatusIcon status={status} />, hint: index < 9 ? String(index + 1) : undefined }))
  return (
    <Picker label={t('tracker.property.changeStatus')} options={options} selected={[issue.statusId]} onPick={(statusId) => update({ id: issue.id, input: { statusId } })} empty={t('tracker.picker.empty')}>
      <Trigger variant={variant} label={`${t('tracker.property.status')}: ${current?.name ?? '—'}`}>
        <StatusIcon status={current} />
        {variant === 'row' ? <span className="truncate">{current?.name ?? '—'}</span> : null}
      </Trigger>
    </Picker>
  )
}

export function PriorityPicker({ issue, variant = 'chip' }: { issue: IssueSummary; variant?: ChipVariant }) {
  const { t } = useText()
  const { update } = useIssueEditor()
  const options: PickerOption[] = PRIORITIES.map((priority, index) => ({ value: priority, label: t(`tracker.priority.${priority}`), icon: <PriorityIcon priority={priority} />, hint: String(index) }))
  return (
    <Picker
      label={t('tracker.property.changePriority')}
      options={options}
      selected={[issue.priority]}
      onPick={(priority) => update({ id: issue.id, input: { priority: priority as Priority } })}
      empty={t('tracker.picker.empty')}
    >
      <Trigger variant={variant} label={`${t('tracker.property.priority')}: ${t(`tracker.priority.${issue.priority}`)}`}>
        <PriorityIcon priority={issue.priority} />
        {variant === 'row' ? <span className="truncate">{t(`tracker.priority.${issue.priority}`)}</span> : null}
      </Trigger>
    </Picker>
  )
}

/** Type of one issue. Choices the hierarchy forbids here (against its parent and its children) are shown disabled. */
export function TypePicker({ issue }: { issue: Issue }) {
  const { t } = useText()
  const { update } = useIssueEditor()
  const children = useQuery({ ...childrenQuery(issue.id), enabled: issue.children.length > 0 })
  const childTypes = (children.data?.items ?? []).map((child) => child.type)
  // Until the children's types are known, only the current type is safe to offer.
  const known = issue.children.length === 0 || children.isSuccess
  const parentLevel = parentLevelOf(issue)
  // bug ↔ other needs a report (API.md); switching to bug happens through the report editor in the detail.
  const options: PickerOption[] = ISSUE_TYPES.filter((type) => type !== 'bug' || issue.type === 'bug').map((type) => {
    const allowed = type === issue.type || (known && canBeType(type, parentLevel, childTypes))
    return { value: type, label: t(`tracker.type.${type}`), icon: <TypeIcon type={type} />, disabled: !allowed, detail: allowed ? undefined : t('tracker.type.notAllowed') }
  })
  return (
    <Picker
      label={t('tracker.property.changeType')}
      options={options}
      selected={[issue.type]}
      onPick={(type) => {
        if (type !== issue.type) update({ id: issue.id, input: { type: type as IssueType } })
      }}
      empty={t('tracker.picker.empty')}
    >
      <Trigger variant="row" label={`${t('tracker.property.type')}: ${t(`tracker.type.${issue.type}`)}`}>
        <TypeIcon type={issue.type} />
        <span className="truncate">{t(`tracker.type.${issue.type}`)}</span>
      </Trigger>
    </Picker>
  )
}

const UNASSIGNED = '__none'

/** An agent as the Actor an issue carries once it is assigned. */
export function agentActor(agent: Agent): Actor {
  return { sub: agentSub(agent.id), name: agent.name, kind: 'agent', agent: { id: agent.id, handle: agent.handle, owner: agent.owner, disabled: agent.disabled } }
}

/**
 * Assignee options: "unassigned", then People (Directory results, the caller
 * and the current assignees), then "Delegate to an agent" — active agents
 * with what to delegate to them. Disabled agents are never offered; an issue
 * that still has one shows it as its current value. `actors` maps every
 * offered subject to its Actor for the optimistic update.
 */
export function usePeopleOptions(query: string, enabled: boolean, extra: (Actor | Person | null)[]) {
  const { t } = useText()
  const { me, activeAgents } = useReference()
  const people = useQuery({ ...peopleQuery(query), enabled })
  const needle = query.trim().toLowerCase()
  const byId = new Map<string, Actor>()
  for (const person of [me, ...extra.filter((candidate) => !isAgent(candidate as Actor | null)), ...(people.data?.items ?? [])]) {
    if (person && (!needle || person.name.toLowerCase().includes(needle))) byId.set(person.sub, { ...person, kind: 'person' })
  }
  const agents = activeAgents.filter((agent) => !needle || `${agent.name} ${agent.handle} ${agent.description}`.toLowerCase().includes(needle))
  const options: PickerOption[] = [
    ...(!needle || t('tracker.property.unassigned').toLowerCase().includes(needle) ? [{ value: UNASSIGNED, label: t('tracker.property.unassigned'), icon: <UserRound className="text-stone-400" /> }] : []),
    ...[...byId.values()].map((person) => ({
      value: person.sub,
      label: person.name,
      icon: <Avatar person={person} size="xs" />,
      hint: person.sub === me.sub ? t('tracker.nav.you') : undefined,
      group: agents.length > 0 ? t('tracker.agent.people') : undefined,
    })),
    ...agents.map((agent) => ({
      value: agentSub(agent.id),
      label: agent.name,
      icon: <Avatar person={{ name: agent.name, kind: 'agent' }} size="xs" />,
      detail: `@${agent.handle}`,
      description: [t('tracker.agent.ownedBy', { name: agent.owner.name }), agent.description].filter(Boolean).join(' · '),
      group: t('tracker.agent.delegate'),
    })),
  ]
  for (const agent of agents) byId.set(agentSub(agent.id), agentActor(agent))
  return { options, people: byId, unavailable: people.data?.source === 'unavailable' }
}

export const assigneeValue = (option: string): string | null => (option === UNASSIGNED ? null : option)

/** The edit that assigns `sub`: picking an agent makes the signed-in person its delegator. */
export function assigneeEdit(id: string, sub: string | null, actors: Map<string, Actor>, me: Person): IssueEdit {
  const assignee = sub ? (actors.get(sub) ?? null) : null
  return { id, input: { assigneeSub: sub }, assignee, delegator: isAgent(assignee) ? { sub: me.sub, name: me.name, avatarUrl: me.avatarUrl } : null }
}

export function AssigneePicker({ issue, variant = 'chip' }: { issue: IssueSummary; variant?: ChipVariant }) {
  const { t } = useText()
  const { me } = useReference()
  const { update } = useIssueEditor()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { options, people } = usePeopleOptions(query, open, [issue.assignee])
  const name = issue.assignee?.name ?? t('tracker.property.unassigned')
  const label = isAgent(issue.assignee) ? t('tracker.agent.avatarLabel', { name, owner: issue.assignee.agent.owner.name }) : name
  return (
    <Picker
      label={t('tracker.property.changeAssignee')}
      options={options}
      selected={[issue.assignee?.sub ?? UNASSIGNED]}
      open={open}
      onOpenChange={setOpen}
      onQueryChange={setQuery}
      onPick={(value) => {
        const sub = assigneeValue(value)
        if (sub === (issue.assignee?.sub ?? null)) return
        update(assigneeEdit(issue.id, sub, people, me))
      }}
      empty={t('tracker.picker.noPeople')}
      align={variant === 'chip' ? 'end' : 'start'}
    >
      <Trigger variant={variant} label={`${t('tracker.property.assignee')}: ${label}`} className={variant === 'chip' ? 'px-0.5' : undefined}>
        {issue.assignee ? <ActorAvatar actor={issue.assignee} size="xs" /> : <UserRound aria-hidden className="size-4 text-stone-400" />}
        {variant === 'row' ? (
          <span className={cn('flex min-w-0 items-center gap-1.5', !issue.assignee && 'text-stone-500')}>
            <span className="truncate">{name}</span>
            {isAgent(issue.assignee) ? <AgentTag disabled={issue.assignee.agent.disabled} /> : null}
          </span>
        ) : null}
      </Trigger>
    </Picker>
  )
}

export function LabelsPicker({ issue, variant = 'chip' }: { issue: IssueSummary; variant?: ChipVariant }) {
  const { t } = useText()
  const { labels, labelById } = useReference()
  const { update } = useIssueEditor()
  const options: PickerOption[] = labels.map((label) => ({ value: label.id, label: label.name, icon: <ColorDot color={label.color} /> }))
  const current = issue.labelIds.map((id) => labelById.get(id)).filter((label) => label !== undefined)
  const summary = current.map((label) => label.name).join(', ') || t('tracker.property.noLabels')
  return (
    <Picker
      label={t('tracker.property.changeLabels')}
      options={options}
      selected={issue.labelIds}
      multiple
      onPick={(labelId) =>
        update({ id: issue.id, input: { labelIds: issue.labelIds.includes(labelId) ? issue.labelIds.filter((id) => id !== labelId) : [...issue.labelIds, labelId] } })
      }
      empty={t('tracker.picker.noLabels')}
    >
      {variant === 'chip' ? (
        <button
          type="button"
          aria-label={`${t('tracker.property.labels')}: ${summary}`}
          onClick={(event) => event.stopPropagation()}
          className={cn('flex min-w-0 shrink items-center gap-1 rounded-md', current.length === 0 && 'hidden')}
        >
          {current.map((label) => (
            <LabelPill key={label.id} name={label.name} color={label.color} />
          ))}
        </button>
      ) : (
        <Trigger variant="row" label={`${t('tracker.property.labels')}: ${summary}`} className="flex-wrap py-1">
          {current.length === 0 ? (
            <>
              <Tag aria-hidden className="size-3.5 text-stone-400" />
              <span className="text-stone-500">{t('tracker.property.noLabels')}</span>
            </>
          ) : (
            current.map((label) => <LabelPill key={label.id} name={label.name} color={label.color} />)
          )}
        </Trigger>
      )}
    </Picker>
  )
}

/** Chip: the project pill, hidden when the issue has none (set it from the detail or ⌘K). Row: swatch and name, or "No project". */
export function IssueProjectPicker({ issue, variant = 'chip' }: { issue: IssueSummary; variant?: ChipVariant }) {
  const { t } = useText()
  const { projectById } = useReference()
  const { update } = useIssueEditor()
  const project = issue.projectId ? projectById.get(issue.projectId) : undefined
  const name = issue.projectId ? (project?.name ?? t('tracker.project.unknown')) : t('tracker.project.none')
  return (
    <ProjectPicker
      value={issue.projectId}
      onChange={(projectId) => {
        if (projectId !== issue.projectId) update({ id: issue.id, input: { projectId } })
      }}
      align={variant === 'chip' ? 'end' : 'start'}
    >
      {variant === 'chip' ? (
        <button type="button" aria-label={`${t('tracker.project.label')}: ${name}`} onClick={(event) => event.stopPropagation()} className={cn('flex min-w-0 shrink items-center rounded-md', !project && 'hidden')}>
          {project ? <ProjectPill project={project} /> : null}
        </button>
      ) : (
        <Trigger variant="row" label={`${t('tracker.project.label')}: ${name}`}>
          {project ? <ProjectSwatch color={project.color} /> : <CircleDashed aria-hidden className="size-3.5 shrink-0 text-stone-400" />}
          <span className={cn('truncate', !project && 'text-stone-500')}>{name}</span>
          {project?.archived ? <span className="shrink-0 text-[11px] text-stone-400">{t('tracker.project.archived')}</span> : null}
        </Trigger>
      )}
    </ProjectPicker>
  )
}

export function LabelPill({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex h-5 max-w-32 shrink-0 items-center gap-1 rounded-full border border-line bg-white px-1.5 text-[11px] font-medium text-stone-600">
      <ColorDot color={color} className="size-2" />
      <span className="truncate">{name}</span>
    </span>
  )
}

/** Picker value of "no estimate" / "backlog". */
export const NONE_VALUE = '__none'

/** XS…XL plus "no estimate"; sizes only, never their points. */
export function estimateOptions(t: Translate): PickerOption[] {
  return [{ value: NONE_VALUE, label: t('tracker.estimate.none'), icon: <CircleDashed className="text-stone-400" /> }, ...SIZES.map((size) => ({ value: size, label: size, icon: <Ruler className="text-stone-400" /> }))]
}

export const estimateValue = (option: string): Size | null => (option === NONE_VALUE ? null : (option as Size))

/** Chip: the size, or (on hover/focus) a faint "estimate" target. Row: the size or "No estimate". An epic shows that it takes none. */
export function EstimatePicker({ issue, variant = 'chip' }: { issue: IssueSummary; variant?: ChipVariant }) {
  const { t } = useText()
  const { update } = useIssueEditor()
  const name = issue.estimate ?? t('tracker.estimate.none')
  if (issue.type === 'epic') {
    return variant === 'chip' ? null : (
      <p className="flex min-h-8 items-center gap-2 px-2 text-[13px] text-stone-400" title={t('tracker.estimate.epic')}>
        <CircleDashed aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{t('tracker.estimate.none')}</span>
        <span className="sr-only">{t('tracker.estimate.epic')}</span>
      </p>
    )
  }
  return (
    <Picker
      label={t('tracker.estimate.change')}
      options={estimateOptions(t)}
      selected={[issue.estimate ?? NONE_VALUE]}
      onPick={(value) => {
        const estimate = estimateValue(value)
        if (estimate !== issue.estimate) update({ id: issue.id, input: { estimate } })
      }}
      empty={t('tracker.picker.empty')}
      align={variant === 'chip' ? 'end' : 'start'}
    >
      {variant === 'chip' ? (
        <Trigger variant="chip" label={`${t('tracker.property.estimate')}: ${name}`} className={cn('px-0.5', !issue.estimate && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100')}>
          {issue.estimate ? <EstimateBadge size={issue.estimate} /> : <Ruler aria-hidden className="size-3.5 text-stone-400" />}
        </Trigger>
      ) : (
        <Trigger variant="row" label={`${t('tracker.property.estimate')}: ${name}`}>
          {issue.estimate ? <EstimateBadge size={issue.estimate} /> : <Ruler aria-hidden className="size-3.5 shrink-0 text-stone-400" />}
          <span className={cn('truncate', !issue.estimate && 'text-stone-500')}>{issue.estimate ? '' : name}</span>
        </Trigger>
      )}
    </Picker>
  )
}

/**
 * The open sprints (and their members, loaded while `enabled`, for the
 * lineage rule) as picker options for `issues`: "Backlog" first, then active
 * and planned sprints; a choice the rules forbid for any of them is disabled
 * with the reason. A closed current sprint is listed (selected, frozen).
 */
export function useSprintOptions(issues: readonly IssueSummary[], enabled: boolean) {
  const { t } = useText()
  const sprints = useQuery(sprintsQuery).data ?? []
  const open = sprints.filter((sprint) => sprint.state !== 'closed')
  const members = useQuery({ ...allIssuesQuery({ sprint: open.map((sprint) => sprint.id) }, 'number'), enabled: enabled && open.length > 0 })
  const reason = (sprint: Sprint | null) => {
    const problem = issues.map((issue) => sprintChoiceProblem(issue, sprint, sprint ? (members.data?.items ?? []).filter((member) => member.sprint?.id === sprint.id) : [])).find(Boolean)
    return problem ? t(`tracker.sprint.problem.${problem}`) : undefined
  }
  const closedCurrent = sprints.filter((sprint) => sprint.state === 'closed' && issues.some((issue) => issue.sprint?.id === sprint.id))
  const options: PickerOption[] = [
    { value: NONE_VALUE, label: t('tracker.sprint.backlog'), icon: <CircleDashed className="text-stone-400" />, disabled: Boolean(reason(null)), detail: reason(null) },
    ...[...open, ...closedCurrent].map((sprint) => {
      const why = reason(sprint)
      return { value: sprint.id, label: sprint.name, icon: <SprintIcon state={sprint.state} />, disabled: Boolean(why), detail: why ?? t(`tracker.sprint.state.${sprint.state}`) }
    }),
  ]
  return { options, sprints, loading: members.isFetching }
}

export const sprintValue = (option: string): string | null => (option === NONE_VALUE ? null : option)

/** Chip: the sprint's name, or (on hover/focus) a faint target. Row: the sprint or "No sprint". An epic shows that it takes none. */
export function SprintPicker({ issue, variant = 'chip' }: { issue: IssueSummary; variant?: ChipVariant }) {
  const { t } = useText()
  const { update } = useIssueEditor()
  const [open, setOpen] = useState(false)
  const { options } = useSprintOptions([issue], open)
  const name = issue.sprint?.name ?? t('tracker.sprint.none')
  if (issue.type === 'epic') {
    return variant === 'chip' ? null : (
      <p className="flex min-h-8 items-center gap-2 px-2 text-[13px] text-stone-400" title={t('tracker.sprint.problem.epic')}>
        <SprintIcon />
        <span className="truncate">{t('tracker.sprint.none')}</span>
        <span className="sr-only">{t('tracker.sprint.problem.epic')}</span>
      </p>
    )
  }
  return (
    <Picker
      label={t('tracker.sprint.move')}
      options={options}
      selected={[issue.sprint?.id ?? NONE_VALUE]}
      open={open}
      onOpenChange={setOpen}
      onPick={(value) => {
        const sprintId = sprintValue(value)
        if (sprintId !== (issue.sprint?.id ?? null)) update({ id: issue.id, input: { sprintId } })
      }}
      empty={t('tracker.picker.empty')}
      align={variant === 'chip' ? 'end' : 'start'}
    >
      {variant === 'chip' ? (
        <Trigger
          variant="chip"
          label={`${t('tracker.property.sprint')}: ${name}`}
          className={cn('max-w-32 border border-line bg-white px-1.5 text-[11px]', !issue.sprint && 'border-dashed opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100')}
        >
          <SprintIcon state={issue.sprint?.state} />
          {issue.sprint ? <span className="truncate">{issue.sprint.name}</span> : null}
        </Trigger>
      ) : (
        <Trigger variant="row" label={`${t('tracker.property.sprint')}: ${name}`}>
          <SprintIcon state={issue.sprint?.state} />
          <span className={cn('truncate', !issue.sprint && 'text-stone-500')}>{name}</span>
        </Trigger>
      )}
    </Picker>
  )
}
