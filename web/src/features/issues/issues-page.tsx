// `/`, `/board`, `/reported`, `/current-sprint`, `/sprints/<id>` and
// `/views/<id>`: project scope switcher, filter bar, list or board, and the
// side panel (`?issue=APT-12`). Keys: J/K (or ↓/↑) move, X selects, Enter
// opens the issue as a panel tab (J/K with the panel open browse within the
// active tab), Esc closes the active tab (then clears the selection). The filter,
// sort, grouping, project scope and open issue live in the URL so a link
// reproduces the screen. On `/`, `/board` and `/reported` a single project
// in the filter travels as `?project=` (paths.ts) and is the scope new issues
// default to; on a view it stays inside the view's filter. `/reported` is the
// built-in "Reported by me" view, `/current-sprint` the built-in "Current
// sprint" board, and `/agents-at-work` and `/waiting-for-people` the built-in
// "Agents at work" board (`run: ['active']`) and "Waiting for people" list
// (`request: ['open']`): they behave like saved views (their filter, sort and layout
// are defaults the URL overrides, with a reset) but nothing is stored, so
// every user has them. A sprint's page shows only its members (the sprint is
// fixed, not part of the editable filter) under the sprint's own header
// (`top`). Grouping by epic, story or sprint (`?group=`, a view's `groupBy`)
// loads every matching issue, so groups and counts are complete; board lanes
// after the first few start collapsed. On the current sprint and a sprint's
// page, the work under a member story is listed with that story.
import { useInfiniteQuery, useQuery, keepPreviousData } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Bot, Bug, Bookmark, Columns3, Hand, List, MoreHorizontal, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { allIssuesQuery, epicsQuery, issuesQuery, sprintsQuery, storiesQuery, useViewMutations } from '../../api/queries'
import type { Filter, GroupBy, IssueSummary, Sort, Sprint, View, ViewLayout } from '../../api/tracker'
import { useText } from '../../i18n'
import { compactFilter, groupIssues, isEmptyFilter, isSummary, type IssueSection } from '../../model/issues'
import { BACKLOG, groupBySprint } from '../../model/sprints'
import { filterParam, paths, parseFilterParam, parseGroupParam, parseLayoutParam, parseSortParam, type ListSearch } from '../../routes/paths'
import { ActionError, Button, ConfirmDialog, EmptyState, HrefLink, Kbd, LinkButton, Loading, LoadFailed, useDocumentTitle, cn } from '../../ui'
import { SprintIcon } from '../sprints/sprint-ui'
import { isPlainShortcut, MOD_KEY, setUi, useUi } from '../ui-state'
import { FilterBar } from './filter-bar'
import { IssueBoard, type BoardLane } from './issue-board'
import { IssuePanel } from './issue-detail'
import { GroupedIssueList, IssueList, type IssueGroup, type RowOptions } from './issue-list'
import { NO_PROJECT, ProjectScopeSwitcher } from './projects'
import { SaveViewDialog } from './save-view-dialog'
import { usePanelTabs } from './use-panel-tabs'
import { useReference } from './use-reference'

export type IssuesPageKind =
  | { kind: 'all' }
  | { kind: 'board' }
  | { kind: 'reported' }
  | { kind: 'currentSprint' }
  | { kind: 'atWork' }
  | { kind: 'waiting' }
  | { kind: 'sprint'; sprint: Sprint }
  | { kind: 'view'; view: View }

type Preset = { filter: Filter; sort: Sort; layout: ViewLayout; groupBy: GroupBy }
/** The built-in "Reported by me" view (API.md v0.1.2): the caller's reports, newest first. */
export const REPORTED_VIEW: Preset = { filter: { reporter: ['me'] }, sort: 'created', layout: 'list', groupBy: 'none' }
/** The built-in "Current sprint" view (API.md v0.1.10): the active sprint as a board. */
export const CURRENT_SPRINT_VIEW: Preset = { filter: { sprint: ['active'] }, sort: 'updated', layout: 'board', groupBy: 'none' }
/** The built-in "Agents at work" view (API.md "Agents", UI): issues with a live run, as a board. */
export const AT_WORK_VIEW: Preset = { filter: { run: ['active'] }, sort: 'updated', layout: 'board', groupBy: 'none' }
/** The built-in "Waiting for people" view: issues with an open request, as a list. */
export const WAITING_VIEW: Preset = { filter: { request: ['open'] }, sort: 'updated', layout: 'list', groupBy: 'none' }
const BUILT_IN: Partial<Record<IssuesPageKind['kind'], Preset>> = { reported: REPORTED_VIEW, currentSprint: CURRENT_SPRINT_VIEW, atWork: AT_WORK_VIEW, waiting: WAITING_VIEW }
/** A sprint's page: its members (the sprint itself is fixed, outside the filter) as a list. */
const SPRINT_PAGE: Preset = { filter: {}, sort: 'updated', layout: 'list', groupBy: 'none' }

const NO_ISSUES: IssueSummary[] = []

/** Board lanes open by default; the rest start collapsed so a large board stays quick. */
const OPEN_LANES = 3

const sameFilter = (a: Filter, b: Filter) => JSON.stringify(compactFilter(a)) === JSON.stringify(compactFilter(b))

export function IssuesPage({ page, path, search, top }: { page: IssuesPageKind; path: string; search: ListSearch; top?: ReactNode }) {
  const { t } = useText()
  const navigate = useNavigate()
  const { statuses, projectById } = useReference()
  const view = page.kind === 'view' ? page.view : undefined
  const pageSprint = page.kind === 'sprint' ? page.sprint : undefined
  // What the page starts from before the URL overrides it: a saved view's filter/sort/layout, a built-in view's, or none.
  const preset: Preset | undefined = view ?? BUILT_IN[page.kind] ?? (pageSprint ? SPRINT_PAGE : undefined)
  // `base` is the filter without the `?project=` scope (views keep their project inside the filter) and without a sprint page's fixed sprint.
  const base = useMemo(() => parseFilterParam(search.filter) ?? preset?.filter ?? {}, [search.filter, preset])
  const filter = useMemo(() => {
    const scoped = !view && search.project ? { ...base, project: [search.project] } : base
    return pageSprint ? { ...scoped, sprint: [pageSprint.id] } : scoped
  }, [base, search.project, view, pageSprint])
  const sort: Sort = parseSortParam(search.sort) ?? preset?.sort ?? 'updated'
  const layout: ViewLayout = page.kind === 'board' ? 'board' : page.kind === 'all' ? 'list' : (parseLayoutParam(search.layout) ?? preset!.layout)
  const groupBy: GroupBy = parseGroupParam(search.group) ?? preset?.groupBy ?? 'none'
  const sprints = useQuery(sprintsQuery)
  const activeSprint = sprints.data?.find((sprint) => sprint.state === 'active')
  const title = view
    ? view.name
    : pageSprint
      ? pageSprint.name
      : page.kind === 'board'
        ? t('tracker.nav.board')
        : page.kind === 'reported'
          ? t('tracker.nav.reported')
          : page.kind === 'currentSprint'
            ? t('tracker.nav.currentSprint')
            : page.kind === 'atWork'
              ? t('tracker.nav.atWork')
              : page.kind === 'waiting'
                ? t('tracker.nav.waiting')
                : t('tracker.nav.issues')
  // One project in the filter is the scope; several show as "N projects" and keep the project chips on rows.
  const scope = filter.project?.length === 1 ? filter.project[0]! : null
  const scopeProject = scope && scope !== NO_PROJECT ? projectById.get(scope) : undefined
  const scopeName = scope === NO_PROJECT ? t('tracker.project.none') : scope ? (scopeProject?.name ?? t('tracker.project.unknown')) : undefined
  useDocumentTitle(scopeName ? `${scopeName} · ${title}` : title)

  const setSearch = useCallback(
    (patch: Partial<ListSearch>, replace = true) => {
      const next: ListSearch = { ...search, ...patch }
      for (const key of Object.keys(next) as (keyof ListSearch)[]) if (!next[key]) delete next[key]
      void navigate({ to: path, search: next, replace } as never)
    },
    [navigate, path, search]
  )
  const onFilter = useCallback(
    (input: Filter) => {
      // A sprint page's sprint is not the filter's to change.
      const next = pageSprint ? { ...input, sprint: undefined } : input
      if (view) return setSearch({ filter: filterParam(next) ?? (!isEmptyFilter(view.filter) ? '{}' : undefined) })
      const single = next.project?.length === 1 ? next.project[0] : undefined
      const rest = single ? { ...next, project: undefined } : next
      // The built-in view's own filter needs no URL; clearing it entirely is `{}`, so the default does not come back.
      setSearch({ project: single, filter: sameFilter(rest, preset?.filter ?? {}) ? undefined : (filterParam(rest) ?? '{}') })
    },
    [setSearch, view, preset, pageSprint]
  )
  const onScope = (next: string | null) => onFilter({ ...filter, project: next ? [next] : undefined })

  // `/`, `/board` and `/reported` hand their scope to the shell: new issues (C) default to it and the sidebar's list links keep it.
  useEffect(() => {
    if (!view) setUi({ scope: search.project ?? null })
  }, [view, search.project])

  const grouped = groupBy !== 'none'
  // Without a grouping the list pages ("もっと見る"); grouped, every matching issue loads so no group is cut short.
  const paged = useInfiniteQuery({ ...issuesQuery(filter, sort), placeholderData: keepPreviousData, enabled: !grouped })
  const whole = useQuery({ ...allIssuesQuery(filter, sort), placeholderData: keepPreviousData, enabled: grouped })
  const query = grouped ? whole : paged
  // Group headers need the grouping issues' status and progress even when the filter leaves them out.
  const known = useQuery({ ...(groupBy === 'story' ? storiesQuery : epicsQuery), enabled: groupBy === 'epic' || groupBy === 'story' })
  const items = useMemo(() => (grouped ? (whole.data?.items ?? []) : (paged.data?.pages.flatMap((pageData) => pageData.items) ?? [])), [grouped, whole.data, paged.data])
  const groups: IssueGroup[] = useMemo(
    () => statuses.map((status) => ({ status, issues: items.filter((issue) => issue.statusId === status.id) })).filter((group) => layout === 'board' || group.issues.length > 0),
    [statuses, items, layout]
  )
  const sections: IssueSection[] = useMemo(
    () => (groupBy === 'sprint' ? groupBySprint(items, sprints.data ?? []) : groupIssues(items, groupBy, known.data?.items)),
    [items, groupBy, known.data, sprints.data]
  )
  // On the sprint screens, the work under each member story (it belongs to the sprint through the story).
  const sprintScreen = page.kind === 'sprint' || page.kind === 'currentSprint'
  const memberStories = useMemo(() => (sprintScreen ? items.filter((issue) => issue.type === 'story').map((issue) => issue.id) : []), [sprintScreen, items])
  const storyWork = useQuery({ ...allIssuesQuery({ story: memberStories }, 'number'), enabled: memberStories.length > 0 })
  const rows: RowOptions = useMemo(() => {
    const nested = new Map<string, IssueSummary[]>()
    for (const work of memberStories.length > 0 ? (storyWork.data?.items ?? NO_ISSUES) : NO_ISSUES) {
      if (!work.story || !memberStories.includes(work.story.id)) continue
      nested.set(work.story.id, [...(nested.get(work.story.id) ?? []), work])
    }
    return { showProject: filter.project?.length !== 1, showSprint: !sprintScreen && groupBy !== 'sprint', nested }
  }, [memberStories, storyWork.data, filter.project, sprintScreen, groupBy])
  const lanes: BoardLane[] = useMemo(
    () => sections.map((section) => ({ section, columns: statuses.map((status) => ({ status, issues: section.issues.filter((issue) => issue.statusId === status.id) })) })),
    [sections, statuses]
  )
  // Explicit open/closed choices per grouping and section; untouched sections follow the default.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const isCollapsed = useCallback(
    (key: string) => toggled[`${groupBy}:${key}`] ?? (layout === 'board' && sections.findIndex((section) => section.key === key) >= OPEN_LANES),
    [toggled, groupBy, layout, sections]
  )
  const onToggle = useCallback((key: string) => setToggled((current) => ({ ...current, [`${groupBy}:${key}`]: !isCollapsed(key) })), [groupBy, isCollapsed])
  const ordered = useMemo(() => {
    if (!grouped) return groups.flatMap((group) => group.issues)
    const open = lanes.filter((lane) => !isCollapsed(lane.section.key))
    return layout === 'board' ? open.flatMap((lane) => lane.columns.flatMap((column) => column.issues)) : open.flatMap((lane) => lane.section.issues)
  }, [grouped, groups, lanes, layout, isCollapsed])

  // Publish what is on screen for the palette and keyboard commands.
  useEffect(() => {
    setUi((state) => ({
      context: ordered,
      focusedId: state.focusedId && ordered.some((issue) => issue.id === state.focusedId) ? state.focusedId : null,
      selectedIds: state.selectedIds.filter((id) => ordered.some((issue) => issue.id === id)),
    }))
  }, [ordered])
  useEffect(() => () => setUi({ context: [], focusedId: null, selectedIds: [] }), [])

  const setIssue = useCallback(
    (issue: string | undefined, replace: boolean) => {
      const next: ListSearch = { ...search, issue }
      if (!issue) delete next.issue
      // The list or board behind the panel keeps its scroll while tabs open, change and close.
      void navigate({ to: path, search: next, replace, resetScroll: false } as never)
    },
    [navigate, path, search]
  )
  const panel = usePanelTabs(search.issue, setIssue)
  const { open, browse, close } = panel
  const focusedId = useUi((state) => state.focusedId)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainShortcut(event)) return
      const key = event.key
      const index = ordered.findIndex((issue) => issue.id === focusedId)
      if (key === 'j' || key === 'k' || key === 'ArrowDown' || key === 'ArrowUp') {
        if (ordered.length === 0 || event.shiftKey) return
        event.preventDefault()
        const step = key === 'j' || key === 'ArrowDown' ? 1 : -1
        const next = ordered[index === -1 ? (step > 0 ? 0 : ordered.length - 1) : Math.min(Math.max(index + step, 0), ordered.length - 1)]!
        setUi({ focusedId: next.id })
        const row = document.querySelector<HTMLElement>(`[data-issue-row="${CSS.escape(next.id)}"]`)
        row?.focus({ preventScroll: true })
        row?.scrollIntoView({ block: 'nearest' })
        if (search.issue) browse(next)
      } else if ((key === 'x' || key === 'X') && !event.shiftKey && index !== -1) {
        event.preventDefault()
        const id = ordered[index]!.id
        setUi((state) => ({ selectedIds: state.selectedIds.includes(id) ? state.selectedIds.filter((selected) => selected !== id) : [...state.selectedIds, id] }))
      } else if (key === 'Enter' && index !== -1) {
        const target = event.target as HTMLElement
        if (target !== document.body && !target.dataset.issueRow) return
        event.preventDefault()
        open(ordered[index]!)
      } else if (key === 'Escape') {
        if (search.issue) {
          event.preventDefault()
          close(search.issue)
          if (focusedId) document.querySelector<HTMLElement>(`[data-issue-row="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true })
        } else setUi({ selectedIds: [] })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [ordered, focusedId, search.issue, open, browse, close])

  const selectedCount = useUi((state) => state.selectedIds.length)
  const [saving, setSaving] = useState(false)
  // New issues land in the scoped project while it is active; "No project", archived or several projects give none. On a sprint's screens they join that sprint.
  const projectDefault = scopeProject && !scopeProject.archived ? scopeProject.id : null
  const sprintDefault = pageSprint && pageSprint.state !== 'closed' ? pageSprint.id : page.kind === 'currentSprint' ? activeSprint?.id : undefined
  // C anywhere on a sprint screen creates into that sprint, like the project scope.
  useEffect(() => {
    setUi({ sprintScope: sprintDefault ?? null })
    return () => setUi({ sprintScope: null })
  }, [sprintDefault])
  const newIssue = (statusId?: string) => setUi({ newIssue: { statusId, projectId: projectDefault, sprintId: sprintDefault } })
  // "+" on a group: its epic/story becomes the parent (a header known only by ref has no type yet, so none is preset); a sprint section's sprint the sprint.
  const newInGroup = (section: IssueSection) =>
    setUi({
      newIssue: {
        projectId: projectDefault,
        parent: section.header && isSummary(section.header) ? section.header : undefined,
        sprintId: groupBy === 'sprint' && section.key !== BACKLOG ? section.key : sprintDefault,
      },
    })
  const dirty =
    preset !== undefined &&
    ((search.filter !== undefined && !sameFilter(base, preset.filter)) ||
      (search.sort !== undefined && sort !== preset.sort) ||
      (search.layout !== undefined && layout !== preset.layout) ||
      (search.group !== undefined && groupBy !== preset.groupBy))
  const reset = () => setSearch({ filter: undefined, sort: undefined, layout: undefined, group: undefined })
  const onlyScope = scope !== null && Object.keys(compactFilter(filter)).length === 1
  const groupedProps = groupBy !== 'none' ? { groupBy, isCollapsed, onToggle, onNewInGroup: newInGroup } : undefined
  const noActiveSprint = page.kind === 'currentSprint' && sprints.isSuccess && !activeSprint

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-white px-4 sm:px-6">
        {sprintScreen ? <SprintIcon state={pageSprint?.state ?? 'active'} className="size-4" /> : page.kind === 'atWork' ? <Bot aria-hidden className="size-4 text-stone-500" /> : page.kind === 'waiting' ? <Hand aria-hidden className="size-4 text-stone-500" /> : null}
        <h1 className="min-w-0 shrink-0 truncate text-[15px] font-semibold text-stone-900">{title}</h1>
        {page.kind === 'currentSprint' && activeSprint ? (
          <HrefLink href={paths.sprint(activeSprint.id)} className="shrink-0 truncate text-[13px] text-stone-500 hover:text-stone-900 hover:underline">
            {activeSprint.name}
          </HrefLink>
        ) : null}
        {view?.shared ? <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500">{t('tracker.view.shared')}</span> : null}
        <ProjectScopeSwitcher value={scope} many={filter.project?.length ?? 0} onChange={onScope} />
        <span className="shrink-0 text-xs text-stone-400 tabular-nums max-sm:hidden">{query.data ? t('tracker.list.count', { count: items.length }) : null}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <LayoutSwitch presetLayout={preset?.layout} layout={layout} search={search} setSearch={setSearch} />
          {view ? <ViewMenu view={view} dirty={dirty} filter={filter} sort={sort} layout={layout} groupBy={groupBy} reset={reset} /> : null}
          {(page.kind === 'reported' || page.kind === 'currentSprint' || page.kind === 'sprint' || page.kind === 'atWork' || page.kind === 'waiting') && dirty ? (
            <Button size="sm" tone="ghost" icon={<RotateCcw />} onClick={reset}>
              {t('tracker.view.reset')}
            </Button>
          ) : null}
          <Button tone="primary" size="sm" icon={<Plus />} onClick={() => newIssue()} title={t('tracker.nav.newIssue')}>
            <span className="max-sm:sr-only">{t('tracker.nav.newIssue')}</span>
            <Kbd className="border-white/30 bg-white/15 text-white max-sm:hidden">C</Kbd>
          </Button>
        </div>
      </header>
      {top}
      <FilterBar
        filter={pageSprint ? { ...filter, sprint: undefined } : filter}
        sort={sort}
        onFilter={onFilter}
        onSort={(next) => setSearch({ sort: next === (preset?.sort ?? 'updated') && !view ? undefined : next })}
        groupBy={groupBy}
        onGroupBy={(next) => setSearch({ group: next === (preset?.groupBy ?? 'none') ? undefined : next })}
        hideSprint={Boolean(pageSprint)}
        actions={
          <Button size="sm" tone="ghost" icon={<Bookmark />} onClick={() => setSaving(true)} className="h-7 md:h-7">
            {t('tracker.view.saveAs')}
          </Button>
        }
      />
      {selectedCount > 0 ? (
        <div role="status" className="flex h-9 shrink-0 items-center gap-3 border-b border-accent-line bg-accent-soft px-4 text-xs text-accent-strong sm:px-6">
          <span>{t('tracker.list.selected', { count: selectedCount })}</span>
          <span className="flex items-center gap-1 text-accent-strong/80">
            <Kbd>{`${MOD_KEY}K`}</Kbd>
            {t('tracker.list.selectedHint')}
          </span>
          <button type="button" onClick={() => setUi({ selectedIds: [] })} className="ml-auto rounded px-1.5 py-0.5 hover:bg-white/60">
            {t('tracker.list.clearSelection')}
          </button>
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        <div className={cn('min-h-0 min-w-0 flex-1', layout === 'list' ? 'overflow-y-auto' : 'overflow-hidden')} aria-busy={query.isFetching || undefined}>
          {query.isPending ? (
            <Loading className="px-6" />
          ) : noActiveSprint ? (
            <div className="p-6">
              <EmptyState
                icon={<SprintIcon />}
                title={t('tracker.sprints.noActive')}
                body={t('tracker.sprints.noActiveBody')}
                action={
                  <LinkButton tone="primary" href={paths.sprints}>
                    {t('tracker.sprints.goSprints')}
                  </LinkButton>
                }
              />
            </div>
          ) : query.isError && !query.data ? (
            <div className="p-6">
              <LoadFailed error={query.error} onRetry={() => void query.refetch()} />
            </div>
          ) : items.length === 0 && (page.kind === 'atWork' || page.kind === 'waiting') && sameFilter(base, preset!.filter) && !search.project ? (
            <div className="p-6">
              <EmptyState
                icon={page.kind === 'atWork' ? <Bot /> : <Hand />}
                title={page.kind === 'atWork' ? t('tracker.atWork.emptyTitle') : t('tracker.waiting.emptyTitle')}
                body={page.kind === 'atWork' ? t('tracker.atWork.emptyBody') : t('tracker.waiting.emptyBody')}
              />
            </div>
          ) : items.length === 0 && layout === 'list' && !(groupBy === 'sprint') ? (
            <div className="p-6">
              {pageSprint && isEmptyFilter(base) && !search.project ? (
                <EmptyState
                  icon={<SprintIcon />}
                  title={t('tracker.sprints.emptySprintTitle')}
                  body={pageSprint.state === 'closed' ? undefined : t('tracker.sprints.emptySprintBody')}
                  action={
                    pageSprint.state === 'closed' ? undefined : (
                      <div className="flex flex-wrap justify-center gap-2">
                        <LinkButton tone="primary" href={`${paths.home}?group=sprint`}>
                          {t('tracker.sprints.planFromBacklog')}
                        </LinkButton>
                        <Button icon={<Plus />} onClick={() => newIssue()}>
                          {t('tracker.nav.newIssue')}
                        </Button>
                      </div>
                    )
                  }
                />
              ) : onlyScope ? (
                <EmptyState
                  title={scope === NO_PROJECT ? t('tracker.project.noneEmptyTitle') : t('tracker.project.emptyTitle', { name: scopeName ?? '' })}
                  body={scope === NO_PROJECT ? undefined : t('tracker.project.emptyBody')}
                  action={
                    scope === NO_PROJECT ? (
                      <Button onClick={() => onScope(null)}>{t('tracker.project.all')}</Button>
                    ) : (
                      <Button tone="primary" icon={<Plus />} onClick={() => newIssue()}>
                        {t('tracker.nav.newIssue')}
                      </Button>
                    )
                  }
                />
              ) : page.kind === 'reported' && sameFilter(base, REPORTED_VIEW.filter) ? (
                <EmptyState
                  icon={<Bug />}
                  title={t('tracker.reported.emptyTitle')}
                  body={scopeName ? t('tracker.reported.emptyScopedBody', { name: scopeName }) : t('tracker.reported.emptyBody')}
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <LinkButton tone="primary" icon={<Bug />} href={paths.report}>
                        {t('tracker.nav.report')}
                      </LinkButton>
                      <Button icon={<Plus />} onClick={() => newIssue()}>
                        {t('tracker.nav.newIssue')}
                      </Button>
                    </div>
                  }
                />
              ) : (
                <EmptyState
                  title={isEmptyFilter(filter) ? t('tracker.list.emptyTitle') : t('tracker.list.noMatchTitle')}
                  body={isEmptyFilter(filter) ? t('tracker.list.emptyBody') : t('tracker.list.noMatchBody')}
                  action={
                    isEmptyFilter(filter) ? (
                      <Button tone="primary" icon={<Plus />} onClick={() => newIssue()}>
                        {t('tracker.nav.newIssue')}
                      </Button>
                    ) : page.kind === 'reported' ? (
                      // Back to the caller's reports (keeping the scope); clearing every filter would list everyone's issues.
                      <Button icon={<RotateCcw />} onClick={reset}>
                        {t('tracker.reported.reset')}
                      </Button>
                    ) : (
                      <Button onClick={() => onFilter({})}>{t('tracker.filter.clear')}</Button>
                    )
                  }
                />
              )}
            </div>
          ) : layout === 'list' ? (
            groupedProps ? (
              <GroupedIssueList sections={sections} {...groupedProps} onOpen={open} rows={rows} />
            ) : (
              <IssueList groups={groups} onOpen={open} onNewIssue={newIssue} rows={rows} />
            )
          ) : (
            <IssueBoard lanes={groupedProps ? lanes : [{ section: sections[0]!, columns: groups }]} grouped={groupedProps} onOpen={open} onNewIssue={newIssue} rows={rows} />
          )}
          {!grouped && paged.hasNextPage ? (
            <div className="flex justify-center py-4">
              <Button size="sm" loading={paged.isFetchingNextPage} onClick={() => void paged.fetchNextPage()}>
                {t('tracker.common.loadMore')}
              </Button>
            </div>
          ) : null}
          {query.isError && query.data ? <ActionError error={query.error} className="m-4" /> : null}
        </div>
        {panel.active ? <IssuePanel identifier={panel.active} panel={panel} /> : null}
      </div>
      <SaveViewDialog open={saving} onOpenChange={setSaving} filter={filter} sort={sort} layout={layout} groupBy={groupBy} />
    </div>
  )
}

/** Views, built-in views and sprint pages switch layout in place (`?layout=`, absent = their own); `/` and `/board` are separate pages. */
function LayoutSwitch({ presetLayout, layout, search, setSearch }: { presetLayout?: ViewLayout; layout: ViewLayout; search: ListSearch; setSearch: (patch: Partial<ListSearch>) => void }) {
  const { t } = useText()
  const item = (value: ViewLayout, icon: ReactNode, label: string) => {
    const className = cn('flex size-7 items-center justify-center rounded text-stone-500 hover:text-stone-900 [&_svg]:size-4', layout === value && 'bg-white text-stone-900 shadow-xs')
    if (presetLayout) {
      return (
        <button type="button" aria-label={label} title={label} aria-pressed={layout === value} onClick={() => setSearch({ layout: value === presetLayout ? undefined : value })} className={className}>
          {icon}
        </button>
      )
    }
    const target = value === 'board' ? paths.board : paths.home
    const query = new URLSearchParams()
    if (search.filter) query.set('filter', search.filter)
    if (search.sort) query.set('sort', search.sort)
    if (search.group) query.set('group', search.group)
    if (search.project) query.set('project', search.project)
    const href = query.toString() ? `${target}?${query}` : target
    return (
      <HrefLink href={href} aria-label={label} title={label} aria-current={layout === value ? 'page' : undefined} className={className}>
        {icon}
      </HrefLink>
    )
  }
  return (
    <div role="group" aria-label={t('tracker.list.layout')} className="flex items-center gap-0.5 rounded-md bg-stone-100 p-0.5">
      {item('list', <List />, t('tracker.list.layoutList'))}
      {item('board', <Columns3 />, t('tracker.nav.board'))}
    </div>
  )
}

/** Update (when the filter, sort, layout or grouping changed), reset and delete for a saved view; owners edit private views, Admins shared ones. */
function ViewMenu({ view, dirty, filter, sort, layout, groupBy, reset }: { view: View; dirty: boolean; filter: Filter; sort: Sort; layout: ViewLayout; groupBy: GroupBy; reset: () => void }) {
  const { t } = useText()
  const navigate = useNavigate()
  const { me } = useReference()
  const { update, remove } = useViewMutations()
  const [confirming, setConfirming] = useState(false)
  const canEdit = view.shared ? me.isAdmin : view.owner.sub === me.sub
  return (
    <>
      {dirty ? (
        <>
          <Button size="sm" tone="ghost" icon={<RotateCcw />} onClick={reset}>
            {t('tracker.view.reset')}
          </Button>
          {canEdit ? (
            <Button size="sm" loading={update.isPending} onClick={() => update.mutate({ id: view.id, input: { filter: compactFilter(filter), sort, layout, groupBy } }, { onSuccess: reset })}>
              {t('tracker.view.update')}
            </Button>
          ) : null}
        </>
      ) : null}
      {canEdit ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" aria-label={t('tracker.view.menu')} title={t('tracker.view.menu')} className="flex size-8 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900">
              <MoreHorizontal aria-hidden className="size-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-40 rounded-lg border border-line bg-white p-1 shadow-lg animate-pop-in">
              <DropdownMenu.Item
                onSelect={() => setConfirming(true)}
                className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-bad-ink outline-none data-[highlighted]:bg-bad-soft"
              >
                <Trash2 aria-hidden className="size-3.5" />
                {t('tracker.view.delete')}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
      {update.error ? <ActionError error={update.error} className="absolute top-14 right-4 z-20" /> : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('tracker.view.deleteTitle', { name: view.name })}
        body={t('tracker.view.deleteBody')}
        confirmLabel={t('tracker.view.delete')}
        tone="danger"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate(view.id, { onSuccess: () => void navigate({ to: paths.home } as never) })}
      />
    </>
  )
}
