// One column per status. Cards drag between columns (native drag and drop) to
// change status; the status chip and the command palette do the same from the
// keyboard. Cards show their project while the board spans projects, their
// sprint while it spans sprints, and their size. With a grouping the board
// has one swimlane per epic, story or sprint (same columns, the lane
// collapsible): dropping a card in another epic/story lane makes that lane's
// issue its parent (the "No epic/story" lane takes it out only when that
// grouping issue is its direct parent); in another sprint lane it moves the
// card to that sprint (or the backlog). Drops the rules forbid are refused
// with a toast. A member story's card lists the work under it. A card with a
// live or stalled agent run shows the agent, its state and latest report; a
// card with open requests shows how many.
import { Plus } from 'lucide-react'
import { useState, type DragEvent, type ReactNode } from 'react'
import type { IssueSummary, UpdateIssueInput } from '../../api/tracker'
import { useText } from '../../i18n'
import { isSummary, levelOf, NO_GROUP, type IssueSection } from '../../model/issues'
import { isSprintSection } from '../../model/sprints'
import { paths } from '../../routes/paths'
import { cn, HrefLink, showToast } from '../../ui'
import { OpenRequestMarker, RunLine } from '../agents/run-status'
import { SprintHeading, useSprintMove } from '../sprints/sprint-sections'
import { setUi, useUi } from '../ui-state'
import { GroupHeading, hierarchyProblem } from './hierarchy'
import { DRAG_TYPE, isPlainClick, NestedWork, type GroupedProps, type IssueGroup, type RowOptions } from './issue-list'
import { AssigneePicker, EstimatePicker, IssueProjectPicker, LabelPill, PriorityPicker, SprintPicker, useIssueEditor } from './properties'
import { useReference } from './use-reference'
import { ProgressBar, StatusIcon, TypeIcon } from './visuals'

/** A board row: its section (the whole board without a grouping) split into status columns. */
export type BoardLane = { section: IssueSection; columns: IssueGroup[] }

type BoardProps = { lanes: BoardLane[]; onOpen: (issue: { identifier: string }) => void; onNewIssue: (statusId: string) => void; rows: RowOptions }

export function IssueBoard(props: BoardProps & { grouped?: Omit<GroupedProps, 'onOpen' | 'rows'> }) {
  const { t } = useText()
  const { update } = useIssueEditor()
  const moveToSprint = useSprintMove()
  const [over, setOver] = useState<string | null>(null)
  const { lanes, onOpen, onNewIssue, rows, grouped } = props
  const drop = (event: DragEvent, laneKey: string, statusId: string) => {
    event.preventDefault()
    setOver(null)
    const issueId = event.dataTransfer.getData(DRAG_TYPE)
    const issue = lanes.flatMap((lane) => lane.columns.flatMap((column) => column.issues)).find((candidate) => candidate.id === issueId)
    const lane = lanes.find((candidate) => candidate.section.key === laneKey)
    if (!issue || !lane) return
    if (grouped?.groupBy === 'sprint' && isSprintSection(lane.section)) return moveToSprint(issue, lane.section, issue.statusId !== statusId ? { statusId } : {})
    const input: UpdateIssueInput = {}
    let parent: IssueSummary | null | undefined
    if (issue.statusId !== statusId) input.statusId = statusId
    const hierarchy = grouped && grouped.groupBy !== 'sprint' ? grouped.groupBy : undefined
    const from = hierarchy ? (issue[hierarchy]?.id ?? NO_GROUP) : laneKey
    if (hierarchy && from !== laneKey) {
      const refuse = (detail: string) => showToast({ tone: 'error', title: t('tracker.hierarchy.moveRefused', { identifier: issue.identifier }), detail })
      const header = lane.section.header
      if (!header) {
        // Out of the group only when the grouping issue is the direct parent; a deeper parent stays and keeps it there.
        if (issue.parent?.id !== from) return refuse(t('tracker.hierarchy.otherParent', { identifier: issue.parent?.identifier ?? '' }))
        input.parentId = null
        parent = null
      } else {
        const problem = hierarchyProblem(t, issue, { id: header.id, type: hierarchy })
        if (problem) return refuse(problem)
        input.parentId = header.id
        parent = isSummary(header) ? header : undefined
      }
    }
    if (Object.keys(input).length > 0) update({ id: issue.id, input, parent })
  }
  const column = (laneKey: string, { status, issues }: IssueGroup, head: ReactNode, fill: boolean) => {
    const target = `${laneKey}:${status.id}`
    return (
      <section
        key={status.id}
        aria-label={head ? undefined : status.name}
        aria-labelledby={head ? `column-${status.id}` : undefined}
        data-status-column={status.id}
        data-lane={laneKey}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setOver(target)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver((current) => (current === target ? null : current))
        }}
        onDrop={(event) => drop(event, laneKey, status.id)}
        className={cn('flex w-72 shrink-0 flex-col rounded-lg bg-stone-100/70 transition-colors', over === target && 'bg-accent-soft ring-1 ring-accent-line')}
      >
        {head}
        <ul className={cn('flex min-h-16 flex-col gap-1.5 px-2 pb-2', fill ? 'flex-1 overflow-y-auto' : 'pt-2')}>
          {issues.map((issue) => (
            <BoardCard key={issue.id} issue={issue} onOpen={onOpen} rows={rows} />
          ))}
        </ul>
      </section>
    )
  }
  const columnHead = ({ status, issues }: IssueGroup, count = issues.length) => (
    <h2 id={`column-${status.id}`} className="flex h-10 shrink-0 items-center gap-2 px-3 text-[13px] font-medium text-stone-700">
      <StatusIcon status={status} />
      <span className="truncate">{status.name}</span>
      <span className="text-stone-400 tabular-nums">{count}</span>
      <button
        type="button"
        aria-label={t('tracker.list.newInStatus', { status: status.name })}
        title={t('tracker.list.newInStatus', { status: status.name })}
        onClick={() => onNewIssue(status.id)}
        className="ml-auto flex size-6 items-center justify-center rounded text-stone-400 hover:bg-stone-200 hover:text-stone-700"
      >
        <Plus aria-hidden className="size-3.5" />
      </button>
    </h2>
  )

  if (!grouped) {
    const lane = lanes[0]
    return (
      <div className="flex h-full min-h-0 gap-3 overflow-x-auto px-4 pt-3 pb-6 sm:px-6">
        {lane?.columns.map((group) => column(lane.section.key, group, columnHead(group), true))}
      </div>
    )
  }
  // Swimlanes: one sticky row of status headings (totals across lanes), then each lane's heading and its cells.
  const totals = lanes[0]?.columns.map((group, index) => ({ ...group, count: lanes.reduce((sum, lane) => sum + (lane.columns[index]?.issues.length ?? 0), 0) })) ?? []
  return (
    <div className="h-full min-h-0 overflow-auto pb-6">
      <div className="w-max min-w-full">
        <div className="sticky top-0 z-[2] flex gap-3 border-b border-line bg-white px-4 py-1 sm:px-6">
          {totals.map((group) => (
            <div key={group.status.id} className="w-72 shrink-0">
              {columnHead(group, group.count)}
            </div>
          ))}
        </div>
        {lanes.map((lane) => {
          const collapsed = grouped.isCollapsed(lane.section.key)
          const count = lane.columns.reduce((sum, group) => sum + group.issues.length, 0)
          return (
            <section key={lane.section.key} aria-label={lane.section.header ? `${lane.section.header.identifier} ${lane.section.header.title}` : undefined} className="border-b border-line">
              {grouped.groupBy === 'sprint' && isSprintSection(lane.section) ? (
                <SprintHeading section={lane.section} count={count} collapsed={collapsed} onToggle={() => grouped.onToggle(lane.section.key)} onNew={() => grouped.onNewInGroup(lane.section)} variant="lane" />
              ) : grouped.groupBy !== 'sprint' ? (
                <GroupHeading
                  section={lane.section}
                  groupBy={grouped.groupBy}
                  count={count}
                  collapsed={collapsed}
                  onToggle={() => grouped.onToggle(lane.section.key)}
                  onOpen={onOpen}
                  onNew={() => grouped.onNewInGroup(lane.section)}
                  variant="lane"
                />
              ) : null}
              <div id={`group-rows-${lane.section.key}`} hidden={collapsed} className="flex gap-3 px-4 pb-3 sm:px-6">
                {collapsed ? null : lane.columns.map((group) => column(lane.section.key, group, null, false))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function BoardCard({ issue, onOpen, rows }: { issue: IssueSummary; onOpen: (issue: { identifier: string }) => void; rows: RowOptions }) {
  const { labelById } = useReference()
  const focused = useUi((state) => state.focusedId === issue.id)
  const selected = useUi((state) => state.selectedIds.includes(issue.id))
  const [dragging, setDragging] = useState(false)
  return (
    <li>
      <div
        data-issue-row={issue.id}
        role="group"
        aria-label={`${issue.identifier} ${issue.title}`}
        tabIndex={focused ? 0 : -1}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, issue.id)
          event.dataTransfer.setData('text/plain', issue.identifier)
          event.dataTransfer.effectAllowed = 'move'
          setDragging(true)
        }}
        onDragEnd={() => setDragging(false)}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setUi({ focusedId: issue.id })
        }}
        onClick={(event) => {
          setUi({ focusedId: issue.id })
          if ((event.target as HTMLElement).closest('button, a, input, [role="dialog"]')) return
          onOpen(issue)
        }}
        className={cn(
          'cursor-grab rounded-md border border-line bg-white px-3 py-2.5 shadow-xs hover:border-stone-300 focus:outline-none active:cursor-grabbing',
          focused && 'border-accent-line ring-1 ring-accent',
          selected && 'bg-accent-soft',
          dragging && 'opacity-50'
        )}
      >
        <div className="flex items-center gap-1.5 text-xs text-stone-500">
          <TypeIcon type={issue.type} />
          <span className="font-mono tabular-nums">{issue.identifier}</span>
          <OpenRequestMarker count={issue.openRequestCount} />
          <span className="ml-auto">
            <AssigneePicker issue={issue} />
          </span>
        </div>
        <HrefLink
          href={paths.issue(issue.identifier)}
          draggable={false}
          className="mt-1 line-clamp-2 block text-[13px] leading-snug font-medium text-stone-800 hover:text-stone-950"
          onClick={(event) => {
            if (!isPlainClick(event)) return
            event.preventDefault()
            setUi({ focusedId: issue.id })
            onOpen(issue)
          }}
        >
          {issue.title}
        </HrefLink>
        {levelOf(issue.type) > 0 && issue.progress ? <ProgressBar progress={issue.progress} className="mt-1.5" /> : null}
        {issue.activeRun ? <RunLine run={issue.activeRun} variant="card" /> : null}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <PriorityPicker issue={issue} />
          <EstimatePicker issue={issue} />
          {rows.showSprint ? <SprintPicker issue={issue} /> : null}
          {rows.showProject && issue.projectId ? <IssueProjectPicker issue={issue} /> : null}
          {issue.labelIds.map((id) => {
            const label = labelById.get(id)
            return label ? <LabelPill key={id} name={label.name} color={label.color} /> : null
          })}
          {issue.report ? <span className="truncate text-[11px] text-stone-400">{issue.report.environment}</span> : null}
        </div>
        {rows.nested?.get(issue.id)?.length ? <NestedWork story={issue} items={rows.nested.get(issue.id)!} onOpen={onOpen} compact /> : null}
      </div>
    </li>
  )
}
