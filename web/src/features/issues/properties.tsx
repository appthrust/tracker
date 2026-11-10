// Issue property pickers (status, priority, assignee, labels, type, project)
// used as compact chips on list rows and board cards and as full rows in the
// detail sidebar. Every pick is an optimistic PATCH; a refused edit rolls back
// and says so in a toast.
import { useQuery } from '@tanstack/react-query'
import { CircleDashed, Tag, UserRound } from 'lucide-react'
import { useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'
import { childrenQuery, peopleQuery, useUpdateIssue, type IssueEdit } from '../../api/queries'
import type { Issue, IssueSummary, IssueType, Person, Priority } from '../../api/tracker'
import { useText } from '../../i18n'
import { canBeType, ISSUE_TYPES, parentLevelOf, PRIORITIES } from '../../model/issues'
import { Avatar, cn, errorDetail, errorMessageId, Picker, showToast, type PickerOption } from '../../ui'
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

/** People options for an assignee choice: Directory results, the caller and the current assignee, then "unassigned". */
export function usePeopleOptions(query: string, enabled: boolean, extra: (Person | null)[]) {
  const { t } = useText()
  const { me } = useReference()
  const people = useQuery({ ...peopleQuery(query), enabled })
  const needle = query.trim().toLowerCase()
  const byId = new Map<string, Person>()
  for (const person of [me, ...extra, ...(people.data?.items ?? [])]) {
    if (person && (!needle || person.name.toLowerCase().includes(needle))) byId.set(person.sub, person)
  }
  const options: PickerOption[] = [
    ...(!needle || t('tracker.property.unassigned').toLowerCase().includes(needle) ? [{ value: UNASSIGNED, label: t('tracker.property.unassigned'), icon: <UserRound className="text-stone-400" /> }] : []),
    ...[...byId.values()].map((person) => ({
      value: person.sub,
      label: person.name,
      icon: <Avatar person={person} size="xs" />,
      hint: person.sub === me.sub ? t('tracker.nav.you') : undefined,
    })),
  ]
  return { options, people: byId, unavailable: people.data?.source === 'unavailable' }
}

export const assigneeValue = (option: string): string | null => (option === UNASSIGNED ? null : option)

export function AssigneePicker({ issue, variant = 'chip' }: { issue: IssueSummary; variant?: ChipVariant }) {
  const { t } = useText()
  const { update } = useIssueEditor()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { options, people } = usePeopleOptions(query, open, [issue.assignee])
  const name = issue.assignee?.name ?? t('tracker.property.unassigned')
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
        update({ id: issue.id, input: { assigneeSub: sub }, assignee: sub ? (people.get(sub) ?? null) : null })
      }}
      empty={t('tracker.picker.noPeople')}
      align={variant === 'chip' ? 'end' : 'start'}
    >
      <Trigger variant={variant} label={`${t('tracker.property.assignee')}: ${name}`} className={variant === 'chip' ? 'px-0.5' : undefined}>
        {issue.assignee ? <Avatar person={issue.assignee} size="xs" /> : <UserRound aria-hidden className="size-4 text-stone-400" />}
        {variant === 'row' ? <span className={cn('truncate', !issue.assignee && 'text-stone-500')}>{name}</span> : null}
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
