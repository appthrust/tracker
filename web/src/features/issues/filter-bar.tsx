// Filter bar over a list or board. Every control maps to one API.md `Filter`
// facet: text (`q`, focused by `/`), status/category, assignee, reporter,
// priority, label, project (shown once the workspace has projects), epic and
// story (with "none"), type, environment, surface, created-after and
// top-level only (`parent: none`). Facets combine with AND, values within a
// facet with OR. Sort and the grouping (none, by epic, by story) sit on the right.
import { useQuery } from '@tanstack/react-query'
import { ArrowDownUp, BookMarked, CalendarDays, Circle, CircleDashed, FolderKanban, Globe, Layers, ListTree, MonitorSmartphone, Rows3, Search, SignalHigh, Tag, UserRound, UserRoundPen, X, Zap } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { epicsQuery, storiesQuery } from '../../api/queries'
import type { Filter, GroupBy, IssueSummary, IssueType, Priority, Sort, StatusCategory, Surface } from '../../api/tracker'
import { useText } from '../../i18n'
import { CATEGORIES, ENVIRONMENT_SUGGESTIONS, GROUP_BYS, isEmptyFilter, ISSUE_TYPES, NO_GROUP, PRIORITIES, SORTS, SURFACES } from '../../model/issues'
import { Avatar, cn, Kbd, Picker, type PickerOption } from '../../ui'
import { NO_PROJECT, ProjectSwatch } from './projects'
import { assigneeValue, usePeopleOptions } from './properties'
import { useReference } from './use-reference'
import { ColorDot, PriorityIcon, StatusIcon, TypeIcon } from './visuals'

export const FILTER_INPUT_ID = 'issue-filter-q'
const Q_DEBOUNCE_MS = 250
const DAY_MS = 86_400_000

const FACET = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-stone-300 px-2 text-xs text-stone-600 hover:border-stone-400 hover:bg-white hover:text-stone-900 data-[state=open]:bg-white [&_svg]:size-3.5'
const FACET_ACTIVE = 'border-solid border-accent-line bg-accent-soft text-accent-strong hover:bg-accent-soft'

function FacetButton({ icon, label, count, ...rest }: { icon: ReactNode; label: string; count: number }) {
  return (
    <button type="button" className={cn(FACET, count > 0 && FACET_ACTIVE)} {...rest}>
      {icon}
      <span>{label}</span>
      {count > 0 ? <span className="rounded bg-white/70 px-1 tabular-nums">{count}</span> : null}
    </button>
  )
}

const toggle = <T extends string>(values: readonly T[] | undefined, value: T): T[] => (values?.includes(value) ? values.filter((item) => item !== value) : [...(values ?? []), value])

export function FilterBar({
  filter,
  sort,
  groupBy,
  onFilter,
  onSort,
  onGroupBy,
  actions,
}: {
  filter: Filter
  sort: Sort
  groupBy: GroupBy
  onFilter: (filter: Filter) => void
  onSort: (sort: Sort) => void
  onGroupBy: (groupBy: GroupBy) => void
  actions?: ReactNode
}) {
  const { t, locale } = useText()
  const { statuses, labels, me, projects } = useReference()
  const [q, setQ] = useState(filter.q ?? '')
  const [peopleQuery, setPeopleQuery] = useState('')
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [reporterQuery, setReporterQuery] = useState('')
  const [reporterOpen, setReporterOpen] = useState(false)
  const [epicOpen, setEpicOpen] = useState(false)
  const [storyOpen, setStoryOpen] = useState(false)
  // The epic and story lists load when their facet opens (or the filter already names one).
  const epics = useQuery({ ...epicsQuery, enabled: epicOpen || (filter.epic?.length ?? 0) > 0 })
  const stories = useQuery({ ...storiesQuery, enabled: storyOpen || (filter.story?.length ?? 0) > 0 })

  // Typing settles before it narrows the list; an outside change (a saved view, clear) resets the box.
  useEffect(() => setQ(filter.q ?? ''), [filter.q])
  useEffect(() => {
    if (q === (filter.q ?? '')) return
    const timer = setTimeout(() => onFilter({ ...filter, q: q || undefined }), Q_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [q, filter, onFilter])

  const statusOptions: PickerOption[] = [
    ...statuses.map((status) => ({ value: status.id, label: status.name, icon: <StatusIcon status={status} /> })),
    ...CATEGORIES.map((category) => ({ value: `category:${category}`, label: t('tracker.filter.categoryOption', { category: t(`tracker.category.${category}`) }), icon: <Layers className="text-stone-400" /> })),
  ]
  const statusSelected = [...(filter.status ?? []), ...(filter.category ?? []).map((category) => `category:${category}`)]
  const people = usePeopleOptions(peopleQuery, peopleOpen, [])
  const assigneeOptions: PickerOption[] = [
    { value: 'me', label: t('tracker.filter.me'), icon: <Avatar person={me} size="xs" /> },
    ...people.options.map((option) => (option.value === assigneeValue(option.value) ? option : { ...option, value: 'none' })),
  ]
  // Every issue has a reporter, so there is no "unassigned" choice; "me" follows whoever is signed in.
  const reporters = usePeopleOptions(reporterQuery, reporterOpen, [])
  const reporterOptions: PickerOption[] = [
    { value: 'me', label: t('tracker.filter.me'), icon: <Avatar person={me} size="xs" /> },
    ...reporters.options.filter((option) => assigneeValue(option.value) !== null),
  ]
  const environments = [...new Set([...ENVIRONMENT_SUGGESTIONS, ...(filter.environment ?? [])])]
  const createdOptions: PickerOption[] = [1, 7, 30, 90].map((days) => ({ value: String(days), label: t('tracker.filter.lastDays', { count: days }) }))
  const createdSelected = filter.createdAfter ? [String(Math.round((Date.now() - Date.parse(filter.createdAfter)) / DAY_MS))] : []
  // Active projects plus any archived one the filter (a saved view) still names.
  const projectOptions: PickerOption[] = [
    ...projects
      .filter((project) => !project.archived || filter.project?.includes(project.id))
      .map((project) => ({ value: project.id, label: project.name, icon: <ProjectSwatch color={project.color} />, detail: project.archived ? t('tracker.project.archived') : undefined })),
    { value: NO_PROJECT, label: t('tracker.project.none'), icon: <CircleDashed className="text-stone-400" /> },
  ]
  const showProjects = projects.some((project) => !project.archived) || (filter.project?.length ?? 0) > 0
  const groupOptions = (items: IssueSummary[] | undefined, none: string): PickerOption[] => [
    ...(items ?? []).map((issue) => ({
      value: issue.id,
      label: `${issue.identifier} ${issue.title}`,
      icon: <TypeIcon type={issue.type} />,
      detail: issue.type === 'story' ? issue.epic?.identifier : undefined,
      keywords: issue.epic?.title,
    })),
    { value: NO_GROUP, label: none, icon: <CircleDashed className="text-stone-400" /> },
  ]

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-stone-50/60 px-4 py-2 sm:px-6">
      <label className="relative flex h-7 w-full items-center sm:w-56">
        <span className="sr-only">{t('tracker.filter.search')}</span>
        <Search aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-stone-400" />
        <input
          id={FILTER_INPUT_ID}
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') (event.target as HTMLInputElement).blur()
          }}
          placeholder={t('tracker.filter.searchPlaceholder')}
          className="h-7 w-full rounded-md border border-stone-300 bg-white pr-8 pl-7 text-xs text-stone-900 placeholder:text-stone-400 focus:border-accent focus:outline-none"
        />
        <Kbd className="absolute right-1.5">/</Kbd>
      </label>

      <Picker
        label={t('tracker.filter.status')}
        options={statusOptions}
        selected={statusSelected}
        multiple
        onPick={(value) =>
          value.startsWith('category:')
            ? onFilter({ ...filter, category: toggle(filter.category, value.slice('category:'.length) as StatusCategory) })
            : onFilter({ ...filter, status: toggle(filter.status, value) })
        }
        empty={t('tracker.picker.empty')}
      >
        <FacetButton icon={<Circle />} label={t('tracker.property.status')} count={statusSelected.length} />
      </Picker>
      <Picker
        label={t('tracker.filter.assignee')}
        options={assigneeOptions}
        selected={filter.assignee ?? []}
        multiple
        open={peopleOpen}
        onOpenChange={setPeopleOpen}
        onQueryChange={setPeopleQuery}
        onPick={(value) => onFilter({ ...filter, assignee: toggle(filter.assignee, value) })}
        empty={t('tracker.picker.noPeople')}
      >
        <FacetButton icon={<UserRound />} label={t('tracker.property.assignee')} count={filter.assignee?.length ?? 0} />
      </Picker>
      <Picker
        label={t('tracker.filter.reporter')}
        options={reporterOptions}
        selected={filter.reporter ?? []}
        multiple
        open={reporterOpen}
        onOpenChange={setReporterOpen}
        onQueryChange={setReporterQuery}
        onPick={(value) => onFilter({ ...filter, reporter: toggle(filter.reporter, value) })}
        empty={t('tracker.picker.noPeople')}
      >
        <FacetButton icon={<UserRoundPen />} label={t('tracker.property.reporter')} count={filter.reporter?.length ?? 0} />
      </Picker>
      <Picker
        label={t('tracker.filter.priority')}
        options={PRIORITIES.map((priority) => ({ value: priority, label: t(`tracker.priority.${priority}`), icon: <PriorityIcon priority={priority} /> }))}
        selected={filter.priority ?? []}
        multiple
        onPick={(value) => onFilter({ ...filter, priority: toggle(filter.priority, value as Priority) })}
        empty={t('tracker.picker.empty')}
      >
        <FacetButton icon={<SignalHigh />} label={t('tracker.property.priority')} count={filter.priority?.length ?? 0} />
      </Picker>
      <Picker
        label={t('tracker.filter.label')}
        options={labels.map((label) => ({ value: label.id, label: label.name, icon: <ColorDot color={label.color} /> }))}
        selected={filter.label ?? []}
        multiple
        onPick={(value) => onFilter({ ...filter, label: toggle(filter.label, value) })}
        empty={t('tracker.picker.noLabels')}
      >
        <FacetButton icon={<Tag />} label={t('tracker.property.labels')} count={filter.label?.length ?? 0} />
      </Picker>
      {showProjects ? (
        <Picker
          label={t('tracker.filter.project')}
          options={projectOptions}
          selected={filter.project ?? []}
          multiple
          onPick={(value) => onFilter({ ...filter, project: toggle(filter.project, value) })}
          empty={t('tracker.project.noMatch')}
        >
          <FacetButton icon={<FolderKanban />} label={t('tracker.project.label')} count={filter.project?.length ?? 0} />
        </Picker>
      ) : null}
      <Picker
        label={t('tracker.filter.epic')}
        options={groupOptions(epics.data?.items, t('tracker.group.noEpic'))}
        selected={filter.epic ?? []}
        multiple
        open={epicOpen}
        onOpenChange={setEpicOpen}
        onPick={(value) => onFilter({ ...filter, epic: toggle(filter.epic, value) })}
        empty={epics.isFetching ? t('tracker.common.loading') : t('tracker.picker.empty')}
      >
        <FacetButton icon={<Zap />} label={t('tracker.type.epic')} count={filter.epic?.length ?? 0} />
      </Picker>
      <Picker
        label={t('tracker.filter.story')}
        options={groupOptions(stories.data?.items, t('tracker.group.noStory'))}
        selected={filter.story ?? []}
        multiple
        open={storyOpen}
        onOpenChange={setStoryOpen}
        onPick={(value) => onFilter({ ...filter, story: toggle(filter.story, value) })}
        empty={stories.isFetching ? t('tracker.common.loading') : t('tracker.picker.empty')}
      >
        <FacetButton icon={<BookMarked />} label={t('tracker.type.story')} count={filter.story?.length ?? 0} />
      </Picker>
      <Picker
        label={t('tracker.filter.type')}
        options={ISSUE_TYPES.map((type) => ({ value: type, label: t(`tracker.type.${type}`), icon: <TypeIcon type={type} /> }))}
        selected={filter.type ?? []}
        multiple
        onPick={(value) => onFilter({ ...filter, type: toggle(filter.type, value as IssueType) })}
        empty={t('tracker.picker.empty')}
      >
        <FacetButton icon={<Layers />} label={t('tracker.property.type')} count={filter.type?.length ?? 0} />
      </Picker>
      <Picker
        label={t('tracker.filter.environment')}
        options={environments.map((environment) => ({ value: environment, label: environment }))}
        selected={filter.environment ?? []}
        multiple
        onPick={(value) => onFilter({ ...filter, environment: toggle(filter.environment, value) })}
        empty={t('tracker.picker.empty')}
      >
        <FacetButton icon={<Globe />} label={t('tracker.report.environment')} count={filter.environment?.length ?? 0} />
      </Picker>
      <Picker
        label={t('tracker.filter.surface')}
        options={SURFACES.map((surface) => ({ value: surface, label: t(`tracker.surface.${surface}`) }))}
        selected={filter.surface ?? []}
        multiple
        onPick={(value) => onFilter({ ...filter, surface: toggle(filter.surface, value as Surface) })}
        empty={t('tracker.picker.empty')}
      >
        <FacetButton icon={<MonitorSmartphone />} label={t('tracker.report.surface')} count={filter.surface?.length ?? 0} />
      </Picker>
      <Picker
        label={t('tracker.filter.created')}
        options={createdOptions}
        selected={createdSelected}
        onPick={(value) =>
          onFilter({ ...filter, createdAfter: createdSelected.includes(value) ? undefined : new Date(Date.now() - Number(value) * DAY_MS).toISOString() })
        }
        empty={t('tracker.picker.empty')}
      >
        <FacetButton icon={<CalendarDays />} label={filter.createdAfter ? t('tracker.filter.createdSince', { date: new Date(filter.createdAfter).toLocaleDateString(locale) }) : t('tracker.property.created')} count={filter.createdAfter ? 1 : 0} />
      </Picker>
      <button
        type="button"
        aria-pressed={filter.parent === 'none'}
        onClick={() => onFilter({ ...filter, parent: filter.parent === 'none' ? undefined : 'none' })}
        className={cn(FACET, filter.parent === 'none' && FACET_ACTIVE)}
      >
        <ListTree aria-hidden />
        <span>{t('tracker.filter.topLevel')}</span>
      </button>
      {!isEmptyFilter(filter) ? (
        <button type="button" onClick={() => onFilter({})} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-900">
          <X aria-hidden className="size-3.5" />
          {t('tracker.filter.clear')}
        </button>
      ) : null}

      <div className="ml-auto flex items-center gap-1.5">
        <label className="relative flex h-7 items-center">
          <Rows3 aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-stone-400" />
          <span className="sr-only">{t('tracker.group.label')}</span>
          <select
            value={groupBy}
            onChange={(event) => onGroupBy(event.target.value as GroupBy)}
            className={cn(
              'h-7 rounded-md border bg-white pr-6 pl-7 text-xs hover:border-stone-400 focus:border-accent focus:outline-none',
              groupBy === 'none' ? 'border-stone-300 text-stone-700' : 'border-accent-line text-accent-strong'
            )}
          >
            {GROUP_BYS.map((option) => (
              <option key={option} value={option}>
                {t(`tracker.group.${option}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="relative flex h-7 items-center">
          <ArrowDownUp aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-stone-400" />
          <span className="sr-only">{t('tracker.filter.sort')}</span>
          <select
            value={sort}
            onChange={(event) => onSort(event.target.value as Sort)}
            className="h-7 rounded-md border border-stone-300 bg-white pr-6 pl-7 text-xs text-stone-700 hover:border-stone-400 focus:border-accent focus:outline-none"
          >
            {SORTS.map((option) => (
              <option key={option} value={option}>
                {t(`tracker.sort.${option}`)}
              </option>
            ))}
          </select>
        </label>
        {actions}
      </div>
    </div>
  )
}
