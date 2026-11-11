// Dense list grouped by status (category order), or — with a grouping — by
// epic, story or sprint in collapsible sections ("No epic/story" and the
// backlog last). Each row: checkbox (X), priority, identifier, status, title
// (epics and stories add their mark and progress), project (when the list
// spans projects), sprint (when it spans sprints), labels, counts, estimate,
// assignee, updated. Grouped by sprint, rows drag between sections to change
// their sprint. On a sprint's own screens the work items under a member story
// render nested below it, read-only for membership (they belong to the
// sprint through the story). Rows are roving-focus targets for J/K; clicking
// a row (or Enter) opens the side panel, the title link opens the full page
// with a modifier click.
import { MessageSquare, Paperclip, Plus } from 'lucide-react'
import { useState, type MouseEvent } from 'react'
import type { GroupBy, IssueSummary, Status } from '../../api/tracker'
import { useText } from '../../i18n'
import { levelOf, NO_GROUP, type IssueSection } from '../../model/issues'
import { isSprintSection } from '../../model/sprints'
import { paths } from '../../routes/paths'
import { cn, formatDate, HrefLink } from '../../ui'
import { EstimateBadge } from '../sprints/sprint-ui'
import { SprintHeading, useSprintMove } from '../sprints/sprint-sections'
import { setUi, useUi } from '../ui-state'
import { GroupHeading } from './hierarchy'
import { AssigneePicker, EstimatePicker, IssueProjectPicker, LabelsPicker, PriorityPicker, SprintPicker, StatusPicker } from './properties'
import { useReference } from './use-reference'
import { ProgressBar, StatusIcon, TypeIcon } from './visuals'

export type IssueGroup = { status: Status; issues: IssueSummary[] }

/** Drag payload of a row or card (its id). */
export const DRAG_TYPE = 'application/x-tracker-issue'

/** A modified or middle click keeps the browser's own link behavior (new tab, copy). */
export const isPlainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/** What rows show: the project chip while the list spans projects, the sprint chip while it spans sprints, and the work nested under member stories (story id → its work items). */
export type RowOptions = { showProject: boolean; showSprint: boolean; nested?: ReadonlyMap<string, IssueSummary[]> }

/** What a grouped list or board needs from its page: the grouping, which sections are closed, and the open/new actions. */
export type GroupedProps = {
  groupBy: Exclude<GroupBy, 'none'>
  isCollapsed: (key: string) => boolean
  onToggle: (key: string) => void
  onOpen: (issue: { identifier: string }) => void
  /** New issue in a section: its epic/story becomes the parent, its sprint the sprint (none for "No epic/story" and the backlog). */
  onNewInGroup: (section: IssueSection) => void
  rows: RowOptions
}

/** Sections by epic, story or sprint; an empty "No epic/story" section is left out (the backlog stays as a drop target). */
export function GroupedIssueList({ sections, groupBy, isCollapsed, onToggle, onOpen, onNewInGroup, rows }: GroupedProps & { sections: IssueSection[] }) {
  const move = useSprintMove()
  const [over, setOver] = useState<string | null>(null)
  const bySprint = groupBy === 'sprint'
  return (
    <div className="pb-24">
      {sections
        .filter((section) => bySprint || section.key !== NO_GROUP || section.issues.length > 0)
        .map((section) => {
          const collapsed = isCollapsed(section.key)
          const heading = {
            count: section.issues.length,
            collapsed,
            onToggle: () => onToggle(section.key),
            onNew: () => onNewInGroup(section),
            variant: 'section' as const,
          }
          return (
            <section
              key={section.key}
              aria-label={section.header ? `${section.header.identifier} ${section.header.title}` : isSprintSection(section) && section.sprint ? section.sprint.name : undefined}
              onDragOver={
                bySprint
                  ? (event) => {
                      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                      setOver(section.key)
                    }
                  : undefined
              }
              onDragLeave={bySprint ? (event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setOver((current) => (current === section.key ? null : current)) : undefined}
              onDrop={
                bySprint && isSprintSection(section)
                  ? (event) => {
                      event.preventDefault()
                      setOver(null)
                      const id = event.dataTransfer.getData(DRAG_TYPE)
                      const issue = sections.flatMap((candidate) => candidate.issues).find((candidate) => candidate.id === id)
                      if (issue) move(issue, section)
                    }
                  : undefined
              }
              className={cn(over === section.key && 'bg-accent-soft/50 ring-1 ring-accent-line ring-inset')}
            >
              {bySprint && isSprintSection(section) ? (
                <SprintHeading section={section} {...heading} />
              ) : groupBy !== 'sprint' ? (
                <GroupHeading section={section} groupBy={groupBy} onOpen={onOpen} {...heading} />
              ) : null}
              <ul id={`group-rows-${section.key}`} hidden={collapsed} className={cn(bySprint && section.issues.length === 0 && 'min-h-6')}>
                {collapsed ? null : section.issues.map((issue) => <IssueRow key={issue.id} issue={issue} onOpen={onOpen} rows={rows} draggable={bySprint} />)}
              </ul>
            </section>
          )
        })}
    </div>
  )
}

export function IssueList({ groups, onOpen, onNewIssue, rows }: { groups: IssueGroup[]; onOpen: (issue: { identifier: string }) => void; onNewIssue: (statusId: string) => void; rows: RowOptions }) {
  const { t } = useText()
  return (
    <div className="pb-24">
      {groups.map(({ status, issues }) => (
        <section key={status.id} aria-labelledby={`group-${status.id}`}>
          <h2 id={`group-${status.id}`} className="sticky top-0 z-[1] flex h-9 items-center gap-2 border-y border-line bg-stone-50/95 px-4 text-[13px] font-medium text-stone-700 backdrop-blur sm:px-6">
            <StatusIcon status={status} />
            <span>{status.name}</span>
            <span className="text-stone-400 tabular-nums">{issues.length}</span>
            <button
              type="button"
              aria-label={t('tracker.list.newInStatus', { status: status.name })}
              title={t('tracker.list.newInStatus', { status: status.name })}
              onClick={() => onNewIssue(status.id)}
              className="ml-auto flex size-6 items-center justify-center rounded text-stone-400 hover:bg-stone-200/60 hover:text-stone-700"
            >
              <Plus aria-hidden className="size-3.5" />
            </button>
          </h2>
          <ul>
            {issues.map((issue) => (
              <IssueRow key={issue.id} issue={issue} onOpen={onOpen} rows={rows} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function IssueRow({ issue, onOpen, rows, draggable = false }: { issue: IssueSummary; onOpen: (issue: { identifier: string }) => void; rows: RowOptions; draggable?: boolean }) {
  const { t, locale } = useText()
  const focused = useUi((state) => state.focusedId === issue.id)
  const selected = useUi((state) => state.selectedIds.includes(issue.id))
  const [dragging, setDragging] = useState(false)
  const toggle = () => setUi((state) => ({ selectedIds: state.selectedIds.includes(issue.id) ? state.selectedIds.filter((id) => id !== issue.id) : [...state.selectedIds, issue.id] }))
  const nested = rows.nested?.get(issue.id) ?? []
  return (
    <li>
      <div
        data-issue-row={issue.id}
        tabIndex={focused ? 0 : -1}
        role="group"
        aria-label={`${issue.identifier} ${issue.title}`}
        draggable={draggable || undefined}
        onDragStart={
          draggable
            ? (event) => {
                event.dataTransfer.setData(DRAG_TYPE, issue.id)
                event.dataTransfer.setData('text/plain', issue.identifier)
                event.dataTransfer.effectAllowed = 'move'
                setDragging(true)
              }
            : undefined
        }
        onDragEnd={draggable ? () => setDragging(false) : undefined}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setUi({ focusedId: issue.id })
        }}
        onClick={(event) => {
          setUi({ focusedId: issue.id })
          if ((event.target as HTMLElement).closest('button, a, input, [role="dialog"]')) return
          onOpen(issue)
        }}
        className={cn(
          'group relative flex h-10 cursor-default items-center gap-1 border-b border-stone-100 pr-3 pl-2 text-[13px] hover:bg-stone-50 focus:outline-none sm:pr-6 sm:pl-4',
          focused && 'bg-stone-50 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent',
          selected && 'bg-accent-soft/60 hover:bg-accent-soft',
          draggable && 'cursor-grab active:cursor-grabbing',
          dragging && 'opacity-50'
        )}
      >
        <label className={cn('flex size-6 shrink-0 items-center justify-center rounded', !selected && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100')}>
          <input type="checkbox" checked={selected} onChange={toggle} className="size-3.5 accent-[var(--color-accent)]" />
          <span className="sr-only">{t('tracker.list.select', { identifier: issue.identifier })}</span>
        </label>
        <PriorityPicker issue={issue} />
        <span className="w-16 shrink-0 truncate font-mono text-xs text-stone-500 tabular-nums">{issue.identifier}</span>
        <StatusPicker issue={issue} />
        {levelOf(issue.type) > 0 ? (
          <span className="ml-1 flex shrink-0 items-center" title={t(`tracker.type.${issue.type}`)}>
            <TypeIcon type={issue.type} />
            <span className="sr-only">{t(`tracker.type.${issue.type}`)}</span>
          </span>
        ) : null}
        <HrefLink
          href={paths.issue(issue.identifier)}
          draggable={false}
          className="ml-1 min-w-0 flex-1 truncate font-medium text-stone-800 hover:text-stone-950"
          onClick={(event) => {
            if (!isPlainClick(event)) return
            event.preventDefault()
            setUi({ focusedId: issue.id })
            onOpen(issue)
          }}
        >
          {issue.title}
        </HrefLink>
        <span className="hidden min-w-0 items-center gap-2 md:flex">
          {issue.progress ? <ProgressBar progress={issue.progress} /> : null}
          {rows.showProject && issue.projectId ? <IssueProjectPicker issue={issue} /> : null}
          {rows.showSprint ? <SprintPicker issue={issue} /> : null}
          <LabelsPicker issue={issue} />
          {issue.commentCount > 0 ? (
            <span className="flex items-center gap-0.5 text-xs text-stone-400" title={t('tracker.list.comments', { count: issue.commentCount })}>
              <MessageSquare aria-hidden className="size-3.5" />
              <span className="sr-only">{t('tracker.list.comments', { count: issue.commentCount })}</span>
              <span aria-hidden>{issue.commentCount}</span>
            </span>
          ) : null}
          {issue.attachmentCount > 0 ? (
            <span className="flex items-center gap-0.5 text-xs text-stone-400" title={t('tracker.list.attachments', { count: issue.attachmentCount })}>
              <Paperclip aria-hidden className="size-3.5" />
              <span className="sr-only">{t('tracker.list.attachments', { count: issue.attachmentCount })}</span>
              <span aria-hidden>{issue.attachmentCount}</span>
            </span>
          ) : null}
        </span>
        <EstimatePicker issue={issue} />
        <time dateTime={issue.updatedAt} className="hidden w-20 shrink-0 text-right text-xs text-stone-400 sm:block">
          {formatDate(issue.updatedAt, locale)}
        </time>
        <AssigneePicker issue={issue} />
      </div>
      {nested.length > 0 ? <NestedWork story={issue} items={nested} onOpen={onOpen} /> : null}
    </li>
  )
}

/** The work items under a member story: status, identifier, title, size; their sprint is the story's, so there is no sprint control. */
export function NestedWork({ story, items, onOpen, compact = false }: { story: IssueSummary; items: IssueSummary[]; onOpen: (issue: { identifier: string }) => void; compact?: boolean }) {
  const { t } = useText()
  const { statusById } = useReference()
  return (
    <ul aria-label={t('tracker.sprint.nestedLabel', { identifier: story.identifier })} className={cn(compact ? 'mt-2 space-y-0.5 border-t border-stone-100 pt-1.5' : 'border-b border-stone-100 bg-stone-50/40 py-1')}>
      {items.map((child) => (
        <li key={child.id} className={cn('flex items-center gap-1.5 text-xs', compact ? 'h-6' : 'h-8 pr-3 pl-14 sm:pr-6 sm:pl-[4.5rem]')}>
          <StatusIcon status={statusById.get(child.statusId)} />
          <span className="shrink-0 font-mono text-stone-500 tabular-nums">{child.identifier}</span>
          <HrefLink
            href={paths.issue(child.identifier)}
            draggable={false}
            className="min-w-0 flex-1 truncate text-stone-700 hover:text-stone-950 hover:underline"
            onClick={(event) => {
              if (!isPlainClick(event)) return
              event.preventDefault()
              onOpen(child)
            }}
          >
            {child.title}
          </HrefLink>
          {child.estimate ? <EstimateBadge size={child.estimate} /> : null}
          {compact ? null : (
            <span className="hidden shrink-0 text-[11px] text-stone-400 sm:inline">
              {/* Lineage-exclusive allows another sprint; otherwise it belongs here through the story. */}
              {child.sprint ? child.sprint.name : t('tracker.sprint.through', { identifier: story.identifier })}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
