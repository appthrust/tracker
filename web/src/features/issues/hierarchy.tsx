// Epic › story › work item (API.md "Epics and stories") in the issue screens:
// the parent picker (only hierarchy-valid parents, labelled by what the
// parent is for this kind of issue), the breadcrumb above the title, an
// epic's or story's child section (progress, stories then work items, add an
// existing issue or a new child), the heading of a grouped list section or
// board lane, and bundling several issues into an epic or story at once.
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ChevronsUpDown, CircleDashed, Plus, X } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import { childrenQuery, epicsQuery, issueSearchQuery, storiesQuery, useUpdateIssues } from '../../api/queries'
import type { Issue, IssueRef, IssueSummary, IssueType } from '../../api/tracker'
import { useText, type Translate } from '../../i18n'
import { canParent, isSummary, levelOf, parentLevelOf, type HierarchyGroupBy, type IssueSection } from '../../model/issues'
import { paths } from '../../routes/paths'
import { cn, errorDetail, errorMessageId, HrefLink, Picker, showToast, type PickerOption } from '../../ui'
import { setUi } from '../ui-state'
import { FieldTrigger } from './projects'
import { IssueSearchPicker } from './relations'
import { useIssueEditor } from './properties'
import { useReference } from './use-reference'
import { ProgressBar, StatusIcon, TypeIcon } from './visuals'

const NO_PARENT = '__none'

/** Why `child` cannot get `parent` (localized), or undefined when it can. */
export function hierarchyProblem(t: Translate, child: { id?: string; type: IssueType }, parent: { id: string; type: IssueType } | null): string | undefined {
  if (!parent) return undefined
  if (parent.id === child.id) return t('tracker.hierarchy.self')
  if (canParent(child.type, parent.type)) return undefined
  return child.type === 'epic' ? t('tracker.hierarchy.epicNoParent') : t('tracker.hierarchy.storyUnderEpic')
}

/** What the parent is called for this kind of issue: an epic for a story, a story (or any parent) for a work item. */
export function parentLabel(t: Translate, type: IssueType): string {
  return type === 'story' ? t('tracker.type.epic') : type === 'epic' ? t('tracker.parent.parent') : t('tracker.parent.storyOrParent')
}

/** Icon for a ref whose level is known: the type mark for an epic or story, else its status. */
function RefIcon({ issue, level }: { issue: Pick<IssueRef, 'statusId'>; level: number }) {
  const { statusById } = useReference()
  return level === 2 ? <TypeIcon type="epic" /> : level === 1 ? <TypeIcon type="story" /> : <StatusIcon status={statusById.get(issue.statusId)} />
}

/**
 * Single parent choice for an issue of `childType`: only valid parents (an
 * epic for a story; a story, epic or other work item for a work item; none
 * for an epic), plus "None" while one is set. Stories search the epics; work
 * items see the stories and epics, or search every issue by text.
 */
export function ParentPicker({
  childType,
  childId,
  exclude = [],
  value,
  onChange,
  children,
  align = 'start',
}: {
  childType: IssueType
  childId?: string
  exclude?: string[]
  value: string | null
  onChange: (parent: IssueSummary | null) => void
  children: ReactNode
  align?: 'start' | 'end'
}) {
  const { t } = useText()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const workItem = levelOf(childType) === 0
  const epics = useQuery({ ...epicsQuery, enabled: open && childType !== 'epic' })
  const stories = useQuery({ ...storiesQuery, enabled: open && workItem })
  const search = useQuery({ ...issueSearchQuery(query), enabled: open && workItem && needle.length > 0 })
  const matches = (issue: IssueSummary) => !needle || `${issue.identifier} ${issue.title}`.toLowerCase().includes(needle)
  const pool = workItem && needle ? (search.data?.items ?? []) : [...(workItem ? (stories.data?.items ?? []) : []), ...(epics.data?.items ?? [])].filter(matches)
  const candidates = pool.filter((issue) => issue.id !== childId && !exclude.includes(issue.id) && canParent(childType, issue.type))
  const options: PickerOption[] = [
    ...(value ? [{ value: NO_PARENT, label: t('tracker.parent.none'), icon: <CircleDashed className="text-stone-400" /> }] : []),
    ...candidates.map((issue) => ({ value: issue.id, label: `${issue.identifier} ${issue.title}`, icon: <TypeIcon type={issue.type} />, detail: issue.type === 'story' ? issue.epic?.identifier : undefined })),
  ]
  const loading = epics.isFetching || stories.isFetching || search.isFetching
  return (
    <Picker
      label={childType === 'story' ? t('tracker.parent.chooseEpic') : t('tracker.parent.choose')}
      options={options}
      selected={value ? [value] : []}
      open={open}
      onOpenChange={setOpen}
      onQueryChange={setQuery}
      placeholder={t('tracker.relation.searchPlaceholder')}
      onPick={(picked) => onChange(picked === NO_PARENT ? null : (candidates.find((issue) => issue.id === picked) ?? null))}
      empty={loading ? t('tracker.common.loading') : t('tracker.relation.noResults')}
      align={align}
    >
      {children}
    </Picker>
  )
}

/** The issue's parent as a property row: a picker of valid parents; an epic shows that it has none. */
export function IssueParentPicker({ issue }: { issue: Issue }) {
  const { t } = useText()
  const { update } = useIssueEditor()
  const level = parentLevelOf(issue)
  const label = parentLabel(t, issue.type)
  const name = issue.parent ? `${issue.parent.identifier} ${issue.parent.title}` : t('tracker.parent.none')
  const row = 'flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-stone-800 hover:bg-stone-100 data-[state=open]:bg-stone-100'
  if (issue.type === 'epic' && !issue.parent) {
    return (
      <p className="flex min-h-8 items-center gap-2 px-2 text-[13px] text-stone-400" title={t('tracker.parent.epicTop')}>
        <CircleDashed aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{t('tracker.parent.none')}</span>
        <span className="sr-only">{t('tracker.parent.epicTop')}</span>
      </p>
    )
  }
  return (
    <ParentPicker
      childType={issue.type}
      childId={issue.id}
      exclude={issue.children.map((child) => child.id)}
      value={issue.parent?.id ?? null}
      onChange={(parent) => {
        if ((parent?.id ?? null) !== (issue.parent?.id ?? null)) update({ id: issue.id, input: { parentId: parent?.id ?? null }, parent })
      }}
    >
      <button type="button" aria-label={`${label}: ${name}`} title={`${label}: ${name}`} className={row}>
        {issue.parent && level !== null ? <RefIcon issue={issue.parent} level={level} /> : <CircleDashed aria-hidden className="size-3.5 shrink-0 text-stone-400" />}
        {issue.parent ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-mono text-xs text-stone-500">{issue.parent.identifier}</span>
            <span className="truncate">{issue.parent.title}</span>
          </span>
        ) : (
          <span className="text-stone-500">{t('tracker.parent.none')}</span>
        )}
      </button>
    </ParentPicker>
  )
}

/** Form control for the new-issue dialog: the chosen parent or "None"; an epic gets none (the field's hint says why). */
export function ParentField({ id, childType, value, onChange }: { id: string; childType: IssueType; value: IssueSummary | null; onChange: (parent: IssueSummary | null) => void }) {
  const { t } = useText()
  if (childType === 'epic') {
    return (
      <FieldTrigger id={id} disabled className="cursor-not-allowed bg-stone-50 text-stone-400">
        <CircleDashed aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{t('tracker.parent.none')}</span>
      </FieldTrigger>
    )
  }
  return (
    <ParentPicker childType={childType} value={value?.id ?? null} onChange={onChange}>
      <FieldTrigger id={id}>
        {value ? <TypeIcon type={value.type} /> : <CircleDashed aria-hidden className="size-3.5 shrink-0 text-stone-400" />}
        <span className={cn('min-w-0 flex-1 truncate text-left', !value && 'text-stone-500')}>{value ? `${value.identifier} ${value.title}` : t('tracker.parent.none')}</span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-stone-400" />
      </FieldTrigger>
    </ParentPicker>
  )
}

/** `Epic › Story › parent › ISSUE-1` above the title; nothing for an issue with no parent. */
export function IssueBreadcrumb({ issue }: { issue: Issue }) {
  const { t } = useText()
  const crumbs: { ref: IssueRef; level: number }[] = [
    ...(issue.epic ? [{ ref: issue.epic, level: 2 }] : []),
    ...(issue.story ? [{ ref: issue.story, level: 1 }] : []),
    ...(issue.parent && parentLevelOf(issue) === 0 ? [{ ref: issue.parent, level: 0 }] : []),
  ]
  if (crumbs.length === 0) return null
  return (
    <nav aria-label={t('tracker.common.breadcrumbs')} className="mb-1">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-stone-500">
        {crumbs.map(({ ref, level }) => (
          <Fragment key={ref.id}>
            <li className="min-w-0">
              <HrefLink href={paths.issue(ref.identifier)} title={`${ref.identifier} ${ref.title}`} className="flex max-w-56 items-center gap-1 rounded hover:text-stone-900 hover:underline">
                <RefIcon issue={ref} level={level} />
                <span className="truncate">{ref.title}</span>
              </HrefLink>
            </li>
            <li aria-hidden>
              <ChevronRight className="size-3 text-stone-400" />
            </li>
          </Fragment>
        ))}
        <li aria-current="page" className="font-mono">
          {issue.identifier}
        </li>
      </ol>
    </nav>
  )
}

/** An epic's or story's direct children: progress, stories (epics only), then work items; add an existing issue or create a child. */
export function HierarchySection({ issue }: { issue: Issue }) {
  const { t } = useText()
  const { statusById } = useReference()
  const { update } = useIssueEditor()
  const children = useQuery(childrenQuery(issue.id))
  const items = children.data?.items ?? []
  const stories = items.filter((child) => child.type === 'story')
  const workItems = items.filter((child) => levelOf(child.type) === 0)
  const ancestors = [issue.epic?.id, issue.story?.id, issue.parent?.id].filter((id): id is string => Boolean(id))
  const list = (title: string, rows: IssueSummary[]) =>
    rows.length > 0 ? (
      <div>
        <h3 className="text-xs font-medium text-stone-500">
          {title} <span className="text-stone-400 tabular-nums">{rows.length}</span>
        </h3>
        <ul className="mt-1">
          {rows.map((child) => (
            <li key={child.id} className="group flex h-8 items-center gap-2 rounded px-1 text-[13px] hover:bg-stone-50">
              {child.type === 'story' ? <TypeIcon type="story" /> : <StatusIcon status={statusById.get(child.statusId)} />}
              <HrefLink href={paths.issue(child.identifier)} className="flex min-w-0 flex-1 items-center gap-2 hover:underline">
                <span className="shrink-0 font-mono text-xs text-stone-500">{child.identifier}</span>
                <span className="truncate text-stone-800">{child.title}</span>
              </HrefLink>
              {child.type === 'story' ? <StatusIcon status={statusById.get(child.statusId)} /> : null}
              {child.progress ? <ProgressBar progress={child.progress} /> : null}
              <button
                type="button"
                aria-label={t('tracker.relation.removeChild', { identifier: child.identifier })}
                title={t('tracker.relation.removeChild', { identifier: child.identifier })}
                onClick={() => update({ id: child.id, input: { parentId: null } })}
                className="rounded p-0.5 text-stone-400 opacity-0 group-hover:opacity-100 hover:text-stone-800 focus:opacity-100"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    ) : null
  const action = 'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-stone-600 hover:bg-stone-100 hover:text-stone-900'
  return (
    <section aria-labelledby={`hierarchy-${issue.id}`} className="space-y-3 rounded-lg border border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={`hierarchy-${issue.id}`} className="text-xs font-semibold text-stone-700">
          {t('tracker.hierarchy.progress')}
        </h2>
        {issue.progress ? <ProgressBar progress={issue.progress} className="[&>[role=progressbar]]:w-32" /> : null}
        <div className="ml-auto flex items-center gap-1">
          <IssueSearchPicker
            label={t('tracker.hierarchy.addExisting')}
            exclude={[issue.id, ...ancestors, ...items.map((child) => child.id)]}
            accept={(candidate) => canParent(candidate.type, issue.type)}
            onPick={(child) => update({ id: child.id, input: { parentId: issue.id }, parent: issue })}
          >
            <button type="button" className={action}>
              <Plus aria-hidden className="size-3.5" />
              {t('tracker.hierarchy.addExisting')}
            </button>
          </IssueSearchPicker>
          <button type="button" className={action} onClick={() => setUi({ newIssue: { type: issue.type === 'epic' ? 'story' : 'task', parent: issue, projectId: issue.projectId } })}>
            <Plus aria-hidden className="size-3.5" />
            {t('tracker.hierarchy.newChild')}
          </button>
        </div>
      </div>
      {list(t('tracker.hierarchy.stories'), stories)}
      {list(t('tracker.hierarchy.workItems'), workItems)}
      {children.isSuccess && items.length === 0 ? <p className="text-xs text-stone-500">{t('tracker.hierarchy.empty')}</p> : null}
    </section>
  )
}

/**
 * Heading of a grouped list section (`section`: full width, sticky at the
 * top) or board lane (`lane`: sticky at the left while the columns scroll):
 * collapse toggle, the grouping issue (identifier, title, status, progress; a
 * story names its epic) or "No epic/story", the row count and "new issue in
 * this group".
 */
export function GroupHeading({
  section,
  groupBy,
  count,
  collapsed,
  onToggle,
  onOpen,
  onNew,
  variant,
}: {
  section: IssueSection
  groupBy: HierarchyGroupBy
  count: number
  collapsed: boolean
  onToggle: () => void
  onOpen: (issue: { identifier: string }) => void
  onNew: () => void
  variant: 'section' | 'lane'
}) {
  const { t } = useText()
  const { statusById } = useReference()
  const header = section.header
  const name = header ? `${header.identifier} ${header.title}` : groupBy === 'epic' ? t('tracker.group.noEpic') : t('tracker.group.noStory')
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
      {header ? (
        <>
          <TypeIcon type={groupBy} />
          <button
            type="button"
            onClick={() => onOpen(header)}
            title={t('tracker.palette.openIssue', { identifier: header.identifier })}
            className="flex min-w-0 items-center gap-2 rounded text-left hover:text-stone-950 hover:underline"
          >
            <span className="shrink-0 font-mono text-xs text-stone-500">{header.identifier}</span>
            <span className="truncate font-medium text-stone-800">{header.title}</span>
          </button>
          <StatusIcon status={statusById.get(header.statusId)} />
          {isSummary(header) && header.type === 'story' && header.epic ? (
            <span className="hidden max-w-48 truncate text-xs text-stone-400 md:inline" title={`${header.epic.identifier} ${header.epic.title}`}>
              {t('tracker.group.inEpic', { name: header.epic.title })}
            </span>
          ) : null}
          {isSummary(header) && header.progress ? <ProgressBar progress={header.progress} /> : null}
        </>
      ) : (
        <>
          <CircleDashed aria-hidden className="size-3.5 shrink-0 text-stone-400" />
          <span className="font-medium text-stone-600">{name}</span>
        </>
      )}
      <span className="shrink-0 text-stone-400 tabular-nums">{count}</span>
      <button
        type="button"
        aria-label={t('tracker.group.newIn', { name })}
        title={t('tracker.group.newIn', { name })}
        onClick={onNew}
        className="ml-auto flex size-6 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-200/60 hover:text-stone-700"
      >
        <Plus aria-hidden className="size-3.5" />
      </button>
    </h2>
  )
}

/**
 * Puts several issues into `group` (an epic or story), or with null takes
 * those whose parent is a `groupBy` issue out of it; issues the hierarchy
 * forbids (or that already sit there) are skipped. One summary toast.
 */
export function useBundling() {
  const { t } = useText()
  const updates = useUpdateIssues()
  return (issues: readonly IssueSummary[], groupBy: HierarchyGroupBy, group: IssueSummary | null) => {
    const movable = group
      ? issues.filter((issue) => issue.parent?.id !== group.id && !hierarchyProblem(t, issue, group))
      : issues.filter((issue) => parentLevelOf(issue) === levelOf(groupBy))
    const skipped = issues.filter((issue) => !movable.includes(issue) && issue.parent?.id !== group?.id).length
    if (movable.length === 0) {
      showToast({ tone: 'error', title: t('tracker.bundle.nothing'), detail: skipped > 0 ? t(group ? 'tracker.bundle.skipped' : 'tracker.bundle.skippedOther', { count: skipped }) : undefined })
      return
    }
    void updates.run(movable.map((issue) => issue.id), { parentId: group?.id ?? null }, undefined, group).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected')
      const done = results.length - failures.length
      const skippedText = skipped > 0 ? t(group ? 'tracker.bundle.skipped' : 'tracker.bundle.skippedOther', { count: skipped }) : undefined
      if (failures[0]?.status === 'rejected') {
        const known = errorMessageId(failures[0].reason)
        showToast({ tone: 'error', title: t('tracker.issue.saveFailed'), detail: [known ? t(known) : undefined, errorDetail(failures[0].reason), skippedText].filter(Boolean).join(' ') || undefined })
      }
      if (done > 0) showToast({ tone: 'success', title: group ? t('tracker.bundle.set', { count: done, name: group.title }) : t('tracker.bundle.removed', { count: done }), detail: skippedText })
    })
  }
}
