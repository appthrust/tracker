// `/`, `/board` and `/views/<id>`: project scope switcher, filter bar, list or
// board, and the side panel (`?issue=APT-12`). Keys: J/K (or ↓/↑) move, X
// selects, Enter opens the panel, Esc closes it (then clears the selection).
// The filter, sort, project scope and open issue live in the URL so a link
// reproduces the screen. On `/` and `/board` a single project in the filter
// travels as `?project=` (paths.ts) and is the scope new issues default to;
// on a view it stays inside the view's filter.
import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Bookmark, Columns3, List, MoreHorizontal, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { issuesQuery, useViewMutations } from '../../api/queries'
import type { Filter, IssueSummary, Sort, View, ViewLayout } from '../../api/tracker'
import { useText } from '../../i18n'
import { compactFilter, isEmptyFilter } from '../../model/issues'
import { filterParam, paths, parseFilterParam, parseLayoutParam, parseSortParam, type ListSearch } from '../../routes/paths'
import { ActionError, Button, ConfirmDialog, EmptyState, HrefLink, Kbd, Loading, LoadFailed, useDocumentTitle, cn } from '../../ui'
import { isPlainShortcut, MOD_KEY, setUi, useUi } from '../ui-state'
import { FilterBar } from './filter-bar'
import { IssueBoard } from './issue-board'
import { IssuePanel } from './issue-detail'
import { IssueList, type IssueGroup } from './issue-list'
import { NO_PROJECT, ProjectScopeSwitcher } from './projects'
import { SaveViewDialog } from './save-view-dialog'
import { useReference } from './use-reference'

export type IssuesPageKind = { kind: 'all' } | { kind: 'board' } | { kind: 'view'; view: View }

const sameFilter = (a: Filter, b: Filter) => JSON.stringify(compactFilter(a)) === JSON.stringify(compactFilter(b))

export function IssuesPage({ page, path, search }: { page: IssuesPageKind; path: string; search: ListSearch }) {
  const { t } = useText()
  const navigate = useNavigate()
  const { statuses, projectById } = useReference()
  const view = page.kind === 'view' ? page.view : undefined
  const filter = useMemo(() => {
    const base = parseFilterParam(search.filter) ?? view?.filter ?? {}
    return !view && search.project ? { ...base, project: [search.project] } : base
  }, [search.filter, search.project, view])
  const sort: Sort = parseSortParam(search.sort) ?? view?.sort ?? 'updated'
  const layout: ViewLayout = page.kind === 'board' ? 'board' : page.kind === 'all' ? 'list' : (parseLayoutParam(search.layout) ?? view!.layout)
  const title = view ? view.name : page.kind === 'board' ? t('tracker.nav.board') : t('tracker.nav.issues')
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
    (next: Filter) => {
      if (view) return setSearch({ filter: filterParam(next) ?? (!isEmptyFilter(view.filter) ? '{}' : undefined) })
      const single = next.project?.length === 1 ? next.project[0] : undefined
      setSearch({ project: single, filter: filterParam(single ? { ...next, project: undefined } : next) })
    },
    [setSearch, view]
  )
  const onScope = (next: string | null) => onFilter({ ...filter, project: next ? [next] : undefined })

  // `/` and `/board` hand their scope to the shell: new issues (C) default to it and the sidebar's list links keep it.
  useEffect(() => {
    if (!view) setUi({ scope: search.project ?? null })
  }, [view, search.project])

  const query = useInfiniteQuery({ ...issuesQuery(filter, sort), placeholderData: keepPreviousData })
  const items = useMemo(() => query.data?.pages.flatMap((pageData) => pageData.items) ?? [], [query.data])
  const groups: IssueGroup[] = useMemo(
    () => statuses.map((status) => ({ status, issues: items.filter((issue) => issue.statusId === status.id) })).filter((group) => layout === 'board' || group.issues.length > 0),
    [statuses, items, layout]
  )
  const ordered = useMemo(() => groups.flatMap((group) => group.issues), [groups])

  // Publish what is on screen for the palette and keyboard commands.
  useEffect(() => {
    setUi((state) => ({
      context: ordered,
      focusedId: state.focusedId && ordered.some((issue) => issue.id === state.focusedId) ? state.focusedId : null,
      selectedIds: state.selectedIds.filter((id) => ordered.some((issue) => issue.id === id)),
    }))
  }, [ordered])
  useEffect(() => () => setUi({ context: [], focusedId: null, selectedIds: [] }), [])

  const open = useCallback((issue: IssueSummary) => setSearch({ issue: issue.identifier }, false), [setSearch])
  const close = useCallback(() => setSearch({ issue: undefined }, false), [setSearch])
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
        if (search.issue) setSearch({ issue: next.identifier })
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
          close()
          if (focusedId) document.querySelector<HTMLElement>(`[data-issue-row="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true })
        } else setUi({ selectedIds: [] })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [ordered, focusedId, search.issue, setSearch, open, close])

  const selectedCount = useUi((state) => state.selectedIds.length)
  const [saving, setSaving] = useState(false)
  // New issues land in the scoped project while it is active; "No project", archived or several projects give none.
  const newIssue = (statusId?: string) => setUi({ newIssue: { statusId, projectId: scopeProject && !scopeProject.archived ? scopeProject.id : null } })
  const dirty = view !== undefined && ((search.filter !== undefined && !sameFilter(filter, view.filter)) || (search.sort !== undefined && sort !== view.sort) || (search.layout !== undefined && layout !== view.layout))
  const onlyScope = scope !== null && Object.keys(compactFilter(filter)).length === 1

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-white px-4 sm:px-6">
        <h1 className="min-w-0 shrink-0 truncate text-[15px] font-semibold text-stone-900">{title}</h1>
        {view?.shared ? <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500">{t('tracker.view.shared')}</span> : null}
        <ProjectScopeSwitcher value={scope} many={filter.project?.length ?? 0} onChange={onScope} />
        <span className="shrink-0 text-xs text-stone-400 tabular-nums max-sm:hidden">{query.data ? t('tracker.list.count', { count: items.length }) : null}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <LayoutSwitch page={page} layout={layout} search={search} setSearch={setSearch} />
          {view ? <ViewMenu view={view} dirty={dirty} filter={filter} sort={sort} layout={layout} reset={() => setSearch({ filter: undefined, sort: undefined, layout: undefined })} /> : null}
          <Button tone="primary" size="sm" icon={<Plus />} onClick={() => newIssue()} title={t('tracker.nav.newIssue')}>
            <span className="max-sm:sr-only">{t('tracker.nav.newIssue')}</span>
            <Kbd className="border-white/30 bg-white/15 text-white max-sm:hidden">C</Kbd>
          </Button>
        </div>
      </header>
      <FilterBar
        filter={filter}
        sort={sort}
        onFilter={onFilter}
        onSort={(next) => setSearch({ sort: next === (view?.sort ?? 'updated') && !view ? undefined : next })}
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
          ) : query.isError && !query.data ? (
            <div className="p-6">
              <LoadFailed error={query.error} onRetry={() => void query.refetch()} />
            </div>
          ) : items.length === 0 && layout === 'list' ? (
            <div className="p-6">
              {onlyScope ? (
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
              ) : (
                <EmptyState
                  title={isEmptyFilter(filter) ? t('tracker.list.emptyTitle') : t('tracker.list.noMatchTitle')}
                  body={isEmptyFilter(filter) ? t('tracker.list.emptyBody') : t('tracker.list.noMatchBody')}
                  action={
                    isEmptyFilter(filter) ? (
                      <Button tone="primary" icon={<Plus />} onClick={() => newIssue()}>
                        {t('tracker.nav.newIssue')}
                      </Button>
                    ) : (
                      <Button onClick={() => onFilter({})}>{t('tracker.filter.clear')}</Button>
                    )
                  }
                />
              )}
            </div>
          ) : layout === 'list' ? (
            <IssueList groups={groups} onOpen={open} onNewIssue={newIssue} showProject={scope === null} />
          ) : (
            <IssueBoard columns={groups} onOpen={open} onNewIssue={newIssue} showProject={scope === null} />
          )}
          {query.hasNextPage ? (
            <div className="flex justify-center py-4">
              <Button size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                {t('tracker.common.loadMore')}
              </Button>
            </div>
          ) : null}
          {query.isError && query.data ? <ActionError error={query.error} className="m-4" /> : null}
        </div>
        {search.issue ? <IssuePanel identifier={search.issue} onClose={close} /> : null}
      </div>
      <SaveViewDialog open={saving} onOpenChange={setSaving} filter={filter} sort={sort} layout={layout} />
    </div>
  )
}

function LayoutSwitch({ page, layout, search, setSearch }: { page: IssuesPageKind; layout: ViewLayout; search: ListSearch; setSearch: (patch: Partial<ListSearch>) => void }) {
  const { t } = useText()
  const item = (value: ViewLayout, icon: ReactNode, label: string) => {
    const className = cn('flex size-7 items-center justify-center rounded text-stone-500 hover:text-stone-900 [&_svg]:size-4', layout === value && 'bg-white text-stone-900 shadow-xs')
    if (page.kind === 'view') {
      return (
        <button type="button" aria-label={label} title={label} aria-pressed={layout === value} onClick={() => setSearch({ layout: value === page.view.layout ? undefined : value })} className={className}>
          {icon}
        </button>
      )
    }
    const target = value === 'board' ? paths.board : paths.home
    const query = new URLSearchParams()
    if (search.filter) query.set('filter', search.filter)
    if (search.sort) query.set('sort', search.sort)
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

/** Update (when the filter changed), reset and delete for a saved view; owners edit private views, Admins shared ones. */
function ViewMenu({ view, dirty, filter, sort, layout, reset }: { view: View; dirty: boolean; filter: Filter; sort: Sort; layout: ViewLayout; reset: () => void }) {
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
            <Button size="sm" loading={update.isPending} onClick={() => update.mutate({ id: view.id, input: { filter: compactFilter(filter), sort, layout } }, { onSuccess: reset })}>
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
