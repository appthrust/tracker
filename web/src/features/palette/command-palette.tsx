// ⌘/Ctrl+K command palette: navigate (lists, "Reported by me", projects,
// views, report, settings, issues by identifier or title) and, when issues are focused or
// X-selected, change their status, priority, assignee, labels or project
// (typing a new name offers to create that project and move them into it).
// ↑/↓ move, Enter runs, Backspace on an empty query goes back, Escape closes.
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, Bookmark, Bug, ChevronLeft, Circle, CircleDashed, Columns3, FolderKanban, Languages, List, Plus, Settings, SignalHigh, Tag, UserRound, UserRoundPen } from 'lucide-react'
import { Dialog as RDialog } from 'radix-ui'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { issueSearchQuery, useProjectMutations, useUpdateIssues } from '../../api/queries'
import type { IssueSummary, Person } from '../../api/tracker'
import { setLanguage, useText } from '../../i18n'
import { PRIORITIES } from '../../model/issues'
import { listHref, paths } from '../../routes/paths'
import { cn, errorDetail, errorMessageId, Kbd, showToast, splitHref } from '../../ui'
import { assigneeValue, usePeopleOptions } from '../issues/properties'
import { nextProjectColor, ProjectSwatch } from '../issues/projects'
import { useReference } from '../issues/use-reference'
import { ColorDot, PriorityIcon, StatusIcon } from '../issues/visuals'
import { commandTargets, setUi, uiStore, useUi } from '../ui-state'

type Page = 'root' | 'status' | 'priority' | 'assignee' | 'labels' | 'project'
type Command = { id: string; group: string; label: string; icon?: ReactNode; hint?: string; checked?: boolean; run: () => 'close' | 'stay' }

export function CommandPalette() {
  const open = useUi((state) => state.palette)
  return open ? <Palette /> : null
}

function Palette() {
  const { t, language } = useText()
  const navigate = useNavigate()
  const { statuses, labels, views, projects, activeProjects } = useReference()
  const createProject = useProjectMutations().create
  const context = useUi((state) => state.context)
  // Snapshot the targets at open: commands keep applying to them while the list re-renders.
  const [targetIds] = useState(() => commandTargets(uiStore.state).map((issue) => issue.id))
  const current = targetIds.map((id) => context.find((issue) => issue.id === id)).filter((issue): issue is IssueSummary => issue !== undefined)
  const [page, setPage] = useState<Page>('root')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const updates = useUpdateIssues()
  const people = usePeopleOptions(page === 'assignee' ? query : '', page === 'assignee', current.map((issue) => issue.assignee))
  const search = useQuery({ ...issueSearchQuery(query), enabled: page === 'root' && query.trim().length > 0 })

  const close = () => setUi({ palette: false })
  const go = (href: string) => () => {
    const { to, search: params } = splitHref(href)
    void navigate({ to, search: params } as never)
    return 'close' as const
  }
  const apply = (input: Parameters<typeof updates.run>[1], assignee?: Person | null) => {
    void updates.run(current.map((issue) => issue.id), input, assignee).then((results) => {
      const failure = results.find((result) => result.status === 'rejected')
      if (failure && failure.status === 'rejected') {
        const known = errorMessageId(failure.reason)
        showToast({ tone: 'error', title: t('tracker.issue.saveFailed'), detail: [known ? t(known) : undefined, errorDetail(failure.reason)].filter(Boolean).join(' ') || undefined })
      }
    })
  }
  const subject = current.length === 1 ? current[0]!.identifier : t('tracker.list.count', { count: current.length })

  const commands: Command[] = (() => {
    const groupActions = t('tracker.palette.groupActions', { subject })
    if (page === 'status')
      return statuses.map((status, index) => ({
        id: `status-${status.id}`,
        group: groupActions,
        label: status.name,
        icon: <StatusIcon status={status} />,
        hint: String(index + 1),
        checked: current.length > 0 && current.every((issue) => issue.statusId === status.id),
        run: () => (apply({ statusId: status.id }), 'close'),
      }))
    if (page === 'priority')
      return PRIORITIES.map((priority) => ({
        id: `priority-${priority}`,
        group: groupActions,
        label: t(`tracker.priority.${priority}`),
        icon: <PriorityIcon priority={priority} />,
        checked: current.length > 0 && current.every((issue) => issue.priority === priority),
        run: () => (apply({ priority }), 'close'),
      }))
    if (page === 'assignee')
      return people.options.map((option) => {
        const sub = assigneeValue(option.value)
        return {
          id: `assignee-${option.value}`,
          group: groupActions,
          label: option.label,
          icon: option.icon,
          hint: option.hint,
          checked: current.length > 0 && current.every((issue) => (issue.assignee?.sub ?? null) === sub),
          run: () => (apply({ assigneeSub: sub }, sub ? (people.people.get(sub) ?? null) : null), 'close'),
        }
      })
    if (page === 'labels')
      return labels.map((label) => {
        const all = current.length > 0 && current.every((issue) => issue.labelIds.includes(label.id))
        return {
          id: `label-${label.id}`,
          group: groupActions,
          label: label.name,
          icon: <ColorDot color={label.color} />,
          checked: all,
          run: () => {
            for (const issue of current) {
              const labelIds = all ? issue.labelIds.filter((id) => id !== label.id) : issue.labelIds.includes(label.id) ? issue.labelIds : [...issue.labelIds, label.id]
              updates.mutate({ id: issue.id, input: { labelIds } })
            }
            return 'stay'
          },
        }
      })
    if (page === 'project') {
      const typed = query.trim()
      const moveTo = (projectId: string | null) => apply({ projectId })
      return [
        {
          id: 'project-none',
          group: groupActions,
          label: t('tracker.project.none'),
          icon: <CircleDashed />,
          checked: current.length > 0 && current.every((issue) => issue.projectId === null),
          run: () => (moveTo(null), 'close'),
        },
        ...activeProjects.map((project) => ({
          id: `project-${project.id}`,
          group: groupActions,
          label: project.name,
          icon: <ProjectSwatch color={project.color} />,
          checked: current.length > 0 && current.every((issue) => issue.projectId === project.id),
          run: () => (moveTo(project.id), 'close' as const),
        })),
        ...(typed && !projects.some((project) => project.name === typed)
          ? [
              {
                id: 'project-create',
                group: groupActions,
                label: t('tracker.project.createNamed', { name: typed }),
                icon: <Plus />,
                run: () => {
                  // The palette closes (unmounts) at once, which drops per-call `mutate` callbacks; the promise still settles.
                  void createProject.mutateAsync({ name: typed, color: nextProjectColor(projects) }).then(
                    (project) => {
                      showToast({ tone: 'success', title: t('tracker.project.created', { name: project.name }) })
                      moveTo(project.id)
                    },
                    (error: unknown) => {
                      const known = errorMessageId(error)
                      showToast({ tone: 'error', title: t('tracker.project.createFailed'), detail: [known ? t(known) : undefined, errorDetail(error)].filter(Boolean).join(' ') || undefined })
                    }
                  )
                  return 'close' as const
                },
              },
            ]
          : []),
      ]
    }

    const list: Command[] = []
    if (current.length > 0) {
      const sub = (next: Page) => () => {
        setPage(next)
        setQuery('')
        setActive(0)
        return 'stay' as const
      }
      list.push(
        { id: 'act-status', group: groupActions, label: t('tracker.property.changeStatus'), icon: <Circle />, run: sub('status') },
        { id: 'act-priority', group: groupActions, label: t('tracker.property.changePriority'), icon: <SignalHigh />, run: sub('priority') },
        { id: 'act-assignee', group: groupActions, label: t('tracker.property.changeAssignee'), icon: <UserRound />, run: sub('assignee') },
        { id: 'act-labels', group: groupActions, label: t('tracker.property.changeLabels'), icon: <Tag />, run: sub('labels') },
        { id: 'act-project', group: groupActions, label: t('tracker.project.change'), icon: <FolderKanban />, run: sub('project') }
      )
      if (current.length === 1) list.push({ id: 'act-open', group: groupActions, label: t('tracker.palette.openIssue', { identifier: current[0]!.identifier }), icon: <ArrowRight />, run: go(paths.issue(current[0]!.identifier)) })
    }
    const nav = t('tracker.palette.groupNavigate')
    list.push(
      { id: 'nav-new', group: nav, label: t('tracker.nav.newIssue'), icon: <Plus />, hint: 'C', run: () => (setUi({ newIssue: {} }), 'close') },
      { id: 'nav-report', group: nav, label: t('tracker.nav.report'), icon: <Bug />, hint: '⇧R', run: go(paths.report) },
      { id: 'nav-issues', group: nav, label: t('tracker.nav.issues'), icon: <List />, run: go(paths.home) },
      { id: 'nav-board', group: nav, label: t('tracker.nav.board'), icon: <Columns3 />, run: go(paths.board) },
      { id: 'nav-reported', group: nav, label: t('tracker.palette.goReported'), icon: <UserRoundPen />, run: go(paths.reported) },
      ...activeProjects.map((project) => ({
        id: `nav-project-${project.id}`,
        group: nav,
        label: t('tracker.palette.goProject', { name: project.name }),
        icon: <ProjectSwatch color={project.color} />,
        run: go(listHref(paths.home, { project: project.id })),
      })),
      ...views.map((view) => ({ id: `nav-view-${view.id}`, group: nav, label: t('tracker.palette.goView', { name: view.name }), icon: <Bookmark />, run: go(paths.view(view.id)) })),
      { id: 'nav-settings-workspace', group: nav, label: t('tracker.settings.workspace'), icon: <Settings />, run: go(paths.settingsWorkspace) },
      { id: 'nav-settings-statuses', group: nav, label: t('tracker.settings.statuses'), icon: <Settings />, run: go(paths.settingsStatuses) },
      { id: 'nav-settings-labels', group: nav, label: t('tracker.property.labels'), icon: <Settings />, run: go(paths.settingsLabels) },
      { id: 'nav-settings-projects', group: nav, label: t('tracker.project.sidebar'), icon: <Settings />, run: go(paths.settingsProjects) },
      {
        id: 'nav-language',
        group: nav,
        label: t('tracker.palette.language', { language: t(language === 'ja' ? 'tracker.language.en' : 'tracker.language.ja') }),
        icon: <Languages />,
        run: () => (setLanguage(language === 'ja' ? 'en' : 'ja'), 'close'),
      }
    )
    return list
  })()

  const needle = query.trim().toLowerCase()
  const visible: Command[] = (() => {
    const filtered = page === 'assignee' || !needle ? commands : commands.filter((command) => command.label.toLowerCase().includes(needle))
    if (page !== 'root' || !needle) return filtered
    const issues = (search.data?.items ?? []).slice(0, 8).map<Command>((issue) => ({
      id: `issue-${issue.id}`,
      group: t('tracker.palette.groupIssues'),
      label: `${issue.identifier} ${issue.title}`,
      icon: <StatusIcon status={statuses.find((status) => status.id === issue.statusId)} />,
      run: go(paths.issue(issue.identifier)),
    }))
    return [...filtered, ...issues]
  })()
  const activeIndex = Math.min(active, Math.max(visible.length - 1, 0))
  useEffect(() => setActive(0), [needle, page])

  const runCommand = (command: Command | undefined) => {
    if (!command) return
    if (command.run() === 'close') close()
  }

  return (
    <RDialog.Root open onOpenChange={(next) => !next && close()}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-stone-900/30 animate-fade-in" />
        <RDialog.Content
          aria-describedby={undefined}
          className="fixed top-[12vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-white shadow-2xl animate-pop-in focus:outline-none"
        >
          <RDialog.Title className="sr-only">{t('tracker.palette.title')}</RDialog.Title>
          {current.length > 0 ? (
            <div className="flex items-center gap-2 border-b border-stone-100 px-4 pt-3 pb-2 text-xs text-stone-500">
              {page !== 'root' ? (
                <button type="button" aria-label={t('tracker.palette.back')} onClick={() => setPage('root')} className="-ml-1 rounded p-0.5 hover:bg-stone-100 hover:text-stone-900">
                  <ChevronLeft aria-hidden className="size-3.5" />
                </button>
              ) : null}
              <span className="truncate rounded bg-stone-100 px-1.5 py-0.5 font-medium text-stone-700">
                {current.length === 1 ? `${current[0]!.identifier} ${current[0]!.title}` : subject}
              </span>
            </div>
          ) : null}
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label={t('tracker.palette.title')}
            aria-activedescendant={visible[activeIndex] ? `${listId}-${activeIndex}` : undefined}
            value={query}
            placeholder={page === 'root' ? t('tracker.palette.placeholder') : t('tracker.palette.placeholderPick')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const step = event.key === 'ArrowDown' ? 1 : -1
                setActive((activeIndex + step + visible.length) % Math.max(visible.length, 1))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                runCommand(visible[activeIndex])
              } else if (event.key === 'Backspace' && !query && page !== 'root') {
                event.preventDefault()
                setPage('root')
              } else if (/^[0-9]$/.test(event.key) && !query && page !== 'root') {
                const command = visible.find((candidate) => candidate.hint === event.key)
                if (command) {
                  event.preventDefault()
                  runCommand(command)
                }
              }
            }}
            className="block h-12 w-full border-b border-line px-4 text-[15px] text-stone-900 placeholder:text-stone-400 focus:outline-none"
          />
          <ul id={listId} role="listbox" aria-label={t('tracker.palette.title')} className="max-h-[50vh] overflow-y-auto p-1.5">
            {visible.length === 0 ? <li className="px-3 py-6 text-center text-sm text-stone-500">{search.isFetching ? t('tracker.common.loading') : t('tracker.palette.empty')}</li> : null}
            {visible.map((command, index) => (
              <li key={command.id} role="presentation">
                {index === 0 || visible[index - 1]!.group !== command.group ? (
                  <p role="presentation" className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-stone-400">
                    {command.group}
                  </p>
                ) : null}
                <div
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-checked={command.checked}
                  onPointerMove={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => runCommand(command)}
                  className={cn(
                    'flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px] text-stone-700 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-stone-500',
                    index === activeIndex && 'bg-stone-100 text-stone-900'
                  )}
                >
                  {command.icon ? <span className="flex shrink-0 items-center">{command.icon}</span> : null}
                  <span className="min-w-0 flex-1 truncate">{command.label}</span>
                  {command.checked ? <span className="text-xs text-accent">✓</span> : null}
                  {command.hint ? <Kbd>{command.hint}</Kbd> : null}
                </div>
              </li>
            ))}
          </ul>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
