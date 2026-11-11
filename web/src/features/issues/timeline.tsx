// Activity, comments, agent runs and requests in one ascending timeline
// (API.md `TimelineItem`), then the comment composer. Activity values follow
// the server's encoding (status → status id, labels → label ids, project →
// project id, assignee → Actor, delegator → Person, parent/blocks → IssueRef,
// attachment → Attachment, estimate → the size, sprint → SprintRef) and fall
// back to the raw value. A delegator change made in the same write as the
// assignment reads as part of "delegated it to …" and is not repeated. The
// composer completes `@handle` mentions of active agents (people are not
// mentionable).
import { Pencil, Trash2 } from 'lucide-react'
import { useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useAddComment, useDeleteComment, useEditComment } from '../../api/queries'
import type { Activity, Agent, Comment, Label, Project, Status, TimelineItem } from '../../api/tracker'
import { useText, type Translate } from '../../i18n'
import { mentionAt } from '../../model/agents'
import { Avatar, Button, ConfirmDialog, formatDateTime, formatRelative, Kbd, Markdown, TextArea, errorMessageId, showToast } from '../../ui'
import { ActorAvatar, ActorName } from '../agents/actor'
import { RequestCard } from '../agents/request-card'
import { RunTimelineEntry } from '../agents/run-block'
import { MOD_KEY } from '../ui-state'
import { markdownFor, transferFiles, useUploader } from './attachments'
import { useReference } from './use-reference'
import { StatusIcon } from './visuals'

const COMMENT_MAX_BYTES = 20_480

type Names = { statusById: Map<string, Status>; labelById: Map<string, Label>; projectById: Map<string, Project>; t: Translate }

/** A readable name for one activity value. */
function valueText(value: unknown, field: Activity['field'], names: Names): string {
  if (field === 'project' && (value === null || value === undefined)) return names.t('tracker.project.none')
  if (value === null || value === undefined || value === '') return names.t('tracker.activity.none')
  if (typeof value === 'string') {
    if (field === 'status') return names.statusById.get(value)?.name ?? value
    if (field === 'labels') return names.labelById.get(value)?.name ?? value
    if (field === 'project') return names.projectById.get(value)?.name ?? names.t('tracker.project.unknown')
    if (field === 'priority') return names.t(`tracker.priority.${value as 'none'}`)
    if (field === 'type') return names.t(`tracker.type.${value as 'bug'}`)
    return value
  }
  if (Array.isArray(value)) return value.map((item) => valueText(item, field, names)).join(', ') || names.t('tracker.activity.none')
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['identifier', 'name', 'filename', 'title'] as const) if (typeof record[key] === 'string') return record[key] as string
  }
  return String(value)
}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function activityText(activity: Activity, names: Names): ReactNode {
  const { t } = names
  const actor = activity.actor.name
  const from = valueText(activity.from, activity.field, names)
  const to = valueText(activity.to, activity.field, names)
  switch (activity.field) {
    case 'created':
      return t('tracker.activity.created', { actor })
    case 'title':
      return t('tracker.activity.title', { actor, to })
    case 'description':
      return t('tracker.activity.description', { actor })
    case 'type':
      return t('tracker.activity.type', { actor, from, to })
    case 'priority':
      return t('tracker.activity.priority', { actor, from, to })
    case 'status': {
      const status = typeof activity.to === 'string' ? names.statusById.get(activity.to) : undefined
      return (
        <>
          {t('tracker.activity.status', { actor, from, to })}
          {status ? <StatusIcon status={status} className="ml-1 inline-block align-[-2px]" /> : null}
        </>
      )
    }
    case 'assignee': {
      if (!activity.to) return t('tracker.activity.unassigned', { actor })
      const toAgent = typeof activity.to === 'object' && 'kind' in activity.to && activity.to.kind === 'agent'
      return toAgent ? t('tracker.activity.delegated', { actor, to }) : t('tracker.activity.assigned', { actor, to })
    }
    case 'delegator':
      return activity.to ? t('tracker.activity.delegator', { actor, to }) : t('tracker.activity.delegatorCleared', { actor })
    case 'labels': {
      const before = asList(activity.from)
      const after = asList(activity.to)
      const added = after.filter((id) => !before.includes(id))
      const removed = before.filter((id) => !after.includes(id))
      return [
        added.length > 0 ? t('tracker.activity.labelsAdded', { actor, labels: valueText(added, 'labels', names) }) : undefined,
        removed.length > 0 ? t('tracker.activity.labelsRemoved', { actor, labels: valueText(removed, 'labels', names) }) : undefined,
      ]
        .filter(Boolean)
        .join(' / ') || t('tracker.activity.labels', { actor })
    }
    case 'parent':
      return activity.to ? t('tracker.activity.parent', { actor, to }) : t('tracker.activity.parentCleared', { actor })
    case 'blocks':
      return t('tracker.activity.blocks', { actor, to })
    case 'due':
      return activity.to ? t('tracker.activity.due', { actor, to }) : t('tracker.activity.dueCleared', { actor })
    case 'report':
      return t('tracker.activity.report', { actor })
    case 'attachment':
      return activity.to ? t('tracker.activity.attached', { actor, name: to }) : t('tracker.activity.detached', { actor, name: from })
    case 'deleted':
      return t('tracker.activity.deleted', { actor })
    case 'project':
      return t('tracker.activity.project', { actor, from, to })
    case 'estimate':
      return activity.to ? t('tracker.activity.estimate', { actor, to }) : t('tracker.activity.estimateCleared', { actor })
    case 'sprint':
      return activity.to ? t('tracker.activity.sprint', { actor, to }) : t('tracker.activity.sprintCleared', { actor })
    default:
      return t('tracker.activity.changed', { actor, field: String(activity.field) })
  }
}

/** A delegator change that rides on an assignment in the same write (same time and actor). */
function delegatorOfAssignment(item: TimelineItem, index: number, items: TimelineItem[]): boolean {
  if (item.kind !== 'activity' || item.activity.field !== 'delegator') return false
  const { createdAt, actor } = item.activity
  return items.some((other, otherIndex) => otherIndex !== index && other.kind === 'activity' && other.activity.field === 'assignee' && other.activity.createdAt === createdAt && other.activity.actor.sub === actor.sub)
}

export function Timeline({ issueId, items }: { issueId: string; items: TimelineItem[] }) {
  const { t, locale } = useText()
  const { statusById, labelById, projectById } = useReference()
  const names: Names = { statusById, labelById, projectById, t }
  return (
    <ol className="space-y-3">
      {items.map((item, index) => {
        if (delegatorOfAssignment(item, index, items)) return null
        if (item.kind === 'activity')
          return (
            <li key={item.activity.id} className="flex items-start gap-2 pl-1 text-xs text-stone-500">
              <ActorAvatar actor={item.activity.actor} />
              <p className="min-w-0 flex-1">
                {activityText(item.activity, names)}
                <span aria-hidden> · </span>
                <time dateTime={item.activity.createdAt} title={formatDateTime(item.activity.createdAt, locale)}>
                  {formatRelative(item.activity.createdAt, locale)}
                </time>
              </p>
            </li>
          )
        if (item.kind === 'run')
          return (
            <li key={item.run.id}>
              <RunTimelineEntry run={item.run} />
            </li>
          )
        if (item.kind === 'request')
          return (
            <li key={item.request.id}>
              <RequestCard request={item.request} variant="timeline" />
            </li>
          )
        return (
          <li key={item.comment.id}>
            <CommentCard issueId={issueId} comment={item.comment} />
          </li>
        )
      })}
    </ol>
  )
}

function CommentCard({ issueId, comment }: { issueId: string; comment: Comment }) {
  const { t, locale } = useText()
  const { me } = useReference()
  const edit = useEditComment(issueId)
  const remove = useDeleteComment(issueId)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const [confirming, setConfirming] = useState(false)
  const mine = comment.author.sub === me.sub
  return (
    <article className="rounded-lg border border-line bg-white" aria-label={t('tracker.comment.by', { name: comment.author.name })}>
      <header className="flex items-center gap-2 px-3 pt-2.5 text-xs text-stone-500">
        <ActorAvatar actor={comment.author} />
        <ActorName actor={comment.author} className="font-medium text-stone-800" />
        <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt, locale)}>
          {formatRelative(comment.createdAt, locale)}
        </time>
        {comment.editedAt ? <span>{t('tracker.comment.edited')}</span> : null}
        <span className="ml-auto flex items-center gap-0.5">
          {mine && !editing ? (
            <button type="button" aria-label={t('tracker.comment.edit')} title={t('tracker.comment.edit')} onClick={() => setEditing(true)} className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
              <Pencil aria-hidden className="size-3.5" />
            </button>
          ) : null}
          {mine || me.isAdmin ? (
            <button type="button" aria-label={t('tracker.comment.delete')} title={t('tracker.comment.delete')} onClick={() => setConfirming(true)} className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-bad-ink">
              <Trash2 aria-hidden className="size-3.5" />
            </button>
          ) : null}
        </span>
      </header>
      <div className="px-3 pt-1 pb-3">
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!draft.trim()) return
              edit.mutate({ id: comment.id, body: draft }, { onSuccess: () => setEditing(false) })
            }}
            className="space-y-2"
          >
            <TextArea aria-label={t('tracker.comment.edit')} value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} autoFocus />
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => (setEditing(false), setDraft(comment.body))}>
                {t('tracker.common.cancel')}
              </Button>
              <Button size="sm" tone="primary" type="submit" loading={edit.isPending} disabled={!draft.trim()}>
                {t('tracker.common.save')}
              </Button>
            </div>
          </form>
        ) : (
          <Markdown source={comment.body} className="text-[13px] leading-relaxed [&>*+*]:mt-2" />
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('tracker.comment.deleteTitle')}
        body={t('tracker.comment.deleteBody')}
        confirmLabel={t('tracker.comment.delete')}
        tone="danger"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate(comment.id, { onSuccess: () => setConfirming(false) })}
      />
    </article>
  )
}

/** Inserts `text` at the caret of `area` (or appends), returning the new value. */
export function insertAtCaret(area: HTMLTextAreaElement | null, value: string, text: string): string {
  if (!area) return value ? `${value}\n${text}` : text
  const start = area.selectionStart ?? value.length
  const end = area.selectionEnd ?? value.length
  const before = value.slice(0, start)
  const glue = before && !before.endsWith('\n') ? '\n' : ''
  return `${before}${glue}${text}${value.slice(end)}`
}

/** Active agents whose handle or name starts with `query` (what follows the typed `@`). */
function mentionCandidates(agents: readonly Agent[], query: string): Agent[] {
  const needle = query.toLowerCase()
  return agents.filter((agent) => agent.handle.startsWith(needle) || agent.name.toLowerCase().startsWith(needle)).slice(0, 6)
}

/**
 * Comment box: Markdown, ⌘/Ctrl+Enter sends, pasted or dropped images upload
 * and land as Markdown images. Typing `@` offers the active agents (↑/↓ move,
 * Enter or Tab inserts `@handle `, Esc dismisses).
 */
export function CommentComposer({ issueId, attachmentCount }: { issueId: string; attachmentCount: number }) {
  const { t } = useText()
  const { me, activeAgents } = useReference()
  const add = useAddComment(issueId)
  const { upload, pending: uploading } = useUploader(issueId, attachmentCount)
  const [body, setBody] = useState('')
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)
  const tooLong = new TextEncoder().encode(body).length > COMMENT_MAX_BYTES
  const listId = `mentions-${issueId}`
  const candidates = mention ? mentionCandidates(activeAgents, mention.query) : []
  const mentionOpen = candidates.length > 0
  const activeMention = Math.min(mentionIndex, Math.max(candidates.length - 1, 0))

  const send = () => {
    if (!body.trim() || tooLong || add.isPending) return
    add.mutate(body, {
      onSuccess: () => setBody(''),
      onError: (error) => {
        const known = errorMessageId(error)
        showToast({ tone: 'error', title: t('tracker.comment.failed'), detail: known ? t(known) : undefined })
      },
    })
  }
  const attachFiles = async (files: File[]) => {
    const done = await upload(files)
    if (done.length > 0) setBody((current) => insertAtCaret(area.current, current, done.map(markdownFor).join('\n')))
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = transferFiles(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    void attachFiles(files)
  }
  /** Re-reads the `@…` word at the caret. */
  const trackMention = (value: string, caret: number) => {
    const next = mentionAt(value, caret)
    setMention(next)
    if (next?.query !== mention?.query) setMentionIndex(0)
  }
  const insertMention = (agent: Agent) => {
    if (!mention) return
    const caret = mention.start + 1 + mention.query.length
    const next = `${body.slice(0, mention.start)}@${agent.handle} ${body.slice(caret)}`
    setBody(next)
    setMention(null)
    const position = mention.start + agent.handle.length + 2
    requestAnimationFrame(() => area.current?.setSelectionRange(position, position))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (mentionOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex((activeMention + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length)
        return
      }
      if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
        event.preventDefault()
        insertMention(candidates[activeMention]!)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setMention(null)
        return
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      send()
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
      className="flex gap-2"
    >
      <Avatar person={me} size="sm" />
      <div className="relative min-w-0 flex-1 rounded-lg border border-stone-300 bg-white focus-within:border-accent">
        <label htmlFor={`comment-${issueId}`} className="sr-only">
          {t('tracker.comment.label')}
        </label>
        <textarea
          id={`comment-${issueId}`}
          ref={area}
          value={body}
          rows={3}
          placeholder={t('tracker.comment.placeholder')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={mentionOpen}
          aria-controls={mentionOpen ? listId : undefined}
          aria-activedescendant={mentionOpen ? `${listId}-${activeMention}` : undefined}
          onChange={(event) => {
            setBody(event.target.value)
            trackMention(event.target.value, event.target.selectionStart)
          }}
          onSelect={(event) => trackMention(event.currentTarget.value, event.currentTarget.selectionStart)}
          onBlur={() => setMention(null)}
          onPaste={onPaste}
          onDrop={(event) => {
            const files = transferFiles(event.dataTransfer)
            if (files.length === 0) return
            event.preventDefault()
            void attachFiles(files)
          }}
          onKeyDown={onKeyDown}
          aria-invalid={tooLong || undefined}
          className="block max-h-80 min-h-20 w-full resize-y rounded-t-lg bg-transparent px-3 py-2 text-[13px] leading-relaxed text-stone-900 placeholder:text-stone-400 focus:outline-none"
        />
        {mentionOpen ? (
          <ul id={listId} role="listbox" aria-label={t('tracker.comment.mentionList')} className="absolute top-full left-2 z-20 mt-1 w-72 rounded-lg border border-line bg-white p-1 shadow-lg animate-pop-in">
            {candidates.map((agent, index) => (
              <li
                key={agent.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeMention}
                onMouseDown={(event) => {
                  event.preventDefault()
                  insertMention(agent)
                }}
                onPointerMove={() => setMentionIndex(index)}
                className={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-[13px] text-stone-700 ${index === activeMention ? 'bg-stone-100 text-stone-900' : ''}`}
              >
                <Avatar person={{ name: agent.name, kind: 'agent' }} size="xs" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {agent.name} <span className="text-stone-400">@{agent.handle}</span>
                  </span>
                  {agent.description ? <span className="line-clamp-1 block text-[11px] text-stone-500">{agent.description}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-2 border-t border-stone-100 px-2 py-1.5">
          <span className="text-[11px] text-stone-400">{uploading ? t('tracker.attachment.uploading') : tooLong ? t('tracker.comment.tooLong') : activeAgents.length > 0 ? t('tracker.comment.mentionHint') : t('tracker.comment.hint')}</span>
          <Button type="submit" size="sm" tone="primary" className="ml-auto h-7 md:h-7" loading={add.isPending} disabled={!body.trim() || tooLong}>
            {t('tracker.comment.send')}
            <Kbd className="border-white/30 bg-white/15 text-white">{`${MOD_KEY}↵`}</Kbd>
          </Button>
        </div>
      </div>
    </form>
  )
}
