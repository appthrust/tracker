// One column per status. Cards drag between columns (native drag and drop) to
// change status; the status chip and the command palette do the same from the
// keyboard.
import { Plus } from 'lucide-react'
import { useState, type DragEvent } from 'react'
import type { IssueSummary } from '../../api/tracker'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { cn, HrefLink } from '../../ui'
import { setUi, useUi } from '../ui-state'
import { isPlainClick, type IssueGroup } from './issue-list'
import { AssigneePicker, LabelPill, PriorityPicker, useIssueEditor } from './properties'
import { useReference } from './use-reference'
import { StatusIcon, TypeIcon } from './visuals'

const DRAG_TYPE = 'application/x-tracker-issue'

export function IssueBoard({ columns, onOpen, onNewIssue }: { columns: IssueGroup[]; onOpen: (issue: IssueSummary) => void; onNewIssue: (statusId: string) => void }) {
  const { t } = useText()
  const { update } = useIssueEditor()
  const [over, setOver] = useState<string | null>(null)
  const drop = (event: DragEvent, statusId: string) => {
    event.preventDefault()
    setOver(null)
    const issueId = event.dataTransfer.getData(DRAG_TYPE)
    const issue = columns.flatMap((column) => column.issues).find((candidate) => candidate.id === issueId)
    if (issue && issue.statusId !== statusId) update({ id: issue.id, input: { statusId } })
  }
  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto px-4 pt-3 pb-6 sm:px-6">
      {columns.map(({ status, issues }) => (
        <section
          key={status.id}
          aria-labelledby={`column-${status.id}`}
          data-status-column={status.id}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setOver(status.id)
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver((current) => (current === status.id ? null : current))
          }}
          onDrop={(event) => drop(event, status.id)}
          className={cn('flex w-72 shrink-0 flex-col rounded-lg bg-stone-100/70 transition-colors', over === status.id && 'bg-accent-soft ring-1 ring-accent-line')}
        >
          <h2 id={`column-${status.id}`} className="flex h-10 shrink-0 items-center gap-2 px-3 text-[13px] font-medium text-stone-700">
            <StatusIcon status={status} />
            <span className="truncate">{status.name}</span>
            <span className="text-stone-400 tabular-nums">{issues.length}</span>
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
          <ul className="flex min-h-16 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
            {issues.map((issue) => (
              <BoardCard key={issue.id} issue={issue} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function BoardCard({ issue, onOpen }: { issue: IssueSummary; onOpen: (issue: IssueSummary) => void }) {
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
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <PriorityPicker issue={issue} />
          {issue.labelIds.map((id) => {
            const label = labelById.get(id)
            return label ? <LabelPill key={id} name={label.name} color={label.color} /> : null
          })}
          {issue.report ? <span className="truncate text-[11px] text-stone-400">{issue.report.environment}</span> : null}
        </div>
      </div>
    </li>
  )
}
