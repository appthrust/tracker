// Dense list grouped by status (category order). Each row: checkbox (X),
// priority, identifier, status, title, labels, counts, assignee, updated.
// Rows are roving-focus targets for J/K; clicking a row (or Enter) opens the
// side panel, the title link opens the full page with a modifier click.
import { MessageSquare, Paperclip, Plus } from 'lucide-react'
import type { MouseEvent } from 'react'
import type { IssueSummary, Status } from '../../api/tracker'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { cn, formatDate, HrefLink } from '../../ui'
import { setUi, useUi } from '../ui-state'
import { AssigneePicker, LabelsPicker, PriorityPicker, StatusPicker } from './properties'
import { StatusIcon } from './visuals'

export type IssueGroup = { status: Status; issues: IssueSummary[] }

/** A modified or middle click keeps the browser's own link behavior (new tab, copy). */
export const isPlainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

export function IssueList({ groups, onOpen, onNewIssue }: { groups: IssueGroup[]; onOpen: (issue: IssueSummary) => void; onNewIssue: (statusId: string) => void }) {
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
              <IssueRow key={issue.id} issue={issue} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function IssueRow({ issue, onOpen }: { issue: IssueSummary; onOpen: (issue: IssueSummary) => void }) {
  const { t, locale } = useText()
  const focused = useUi((state) => state.focusedId === issue.id)
  const selected = useUi((state) => state.selectedIds.includes(issue.id))
  const toggle = () => setUi((state) => ({ selectedIds: state.selectedIds.includes(issue.id) ? state.selectedIds.filter((id) => id !== issue.id) : [...state.selectedIds, issue.id] }))
  return (
    <li>
      <div
        data-issue-row={issue.id}
        tabIndex={focused ? 0 : -1}
        role="group"
        aria-label={`${issue.identifier} ${issue.title}`}
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
          selected && 'bg-accent-soft/60 hover:bg-accent-soft'
        )}
      >
        <label className={cn('flex size-6 shrink-0 items-center justify-center rounded', !selected && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100')}>
          <input type="checkbox" checked={selected} onChange={toggle} className="size-3.5 accent-[var(--color-accent)]" />
          <span className="sr-only">{t('tracker.list.select', { identifier: issue.identifier })}</span>
        </label>
        <PriorityPicker issue={issue} />
        <span className="w-16 shrink-0 truncate font-mono text-xs text-stone-500 tabular-nums">{issue.identifier}</span>
        <StatusPicker issue={issue} />
        <HrefLink
          href={paths.issue(issue.identifier)}
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
        <time dateTime={issue.updatedAt} className="hidden w-20 shrink-0 text-right text-xs text-stone-400 sm:block">
          {formatDate(issue.updatedAt, locale)}
        </time>
        <AssigneePicker issue={issue} />
      </div>
    </li>
  )
}
