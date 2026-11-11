// Activity and comments in one ascending timeline (API.md `TimelineItem`),
// then the comment composer. Activity values follow the server's encoding
// (status → status id, labels → label ids, project → project id, assignee →
// Person, parent/blocks → IssueRef, attachment → Attachment, estimate → the
// size, sprint → SprintRef) and fall back to the raw value.
import { Pencil, Trash2 } from 'lucide-react'
import { useRef, useState, type ClipboardEvent, type ReactNode } from 'react'
import { useAddComment, useDeleteComment, useEditComment } from '../../api/queries'
import type { Activity, Comment, Label, Project, Status, TimelineItem } from '../../api/tracker'
import { useText, type Translate } from '../../i18n'
import { Avatar, Button, ConfirmDialog, formatDateTime, formatRelative, Kbd, Markdown, TextArea, errorMessageId, showToast } from '../../ui'
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
    case 'assignee':
      return activity.to ? t('tracker.activity.assigned', { actor, to }) : t('tracker.activity.unassigned', { actor })
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

export function Timeline({ issueId, items }: { issueId: string; items: TimelineItem[] }) {
  const { t, locale } = useText()
  const { statusById, labelById, projectById } = useReference()
  const names: Names = { statusById, labelById, projectById, t }
  return (
    <ol className="space-y-3">
      {items.map((item) =>
        item.kind === 'activity' ? (
          <li key={item.activity.id} className="flex items-start gap-2 pl-1 text-xs text-stone-500">
            <Avatar person={item.activity.actor} size="xs" />
            <p className="min-w-0 flex-1">
              {activityText(item.activity, names)}
              <span aria-hidden> · </span>
              <time dateTime={item.activity.createdAt} title={formatDateTime(item.activity.createdAt, locale)}>
                {formatRelative(item.activity.createdAt, locale)}
              </time>
            </p>
          </li>
        ) : (
          <li key={item.comment.id}>
            <CommentCard issueId={issueId} comment={item.comment} />
          </li>
        )
      )}
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
        <Avatar person={comment.author} size="xs" />
        <span className="font-medium text-stone-800">{comment.author.name}</span>
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

/** Comment box: Markdown, ⌘/Ctrl+Enter sends, pasted or dropped images upload and land as Markdown images. */
export function CommentComposer({ issueId, attachmentCount }: { issueId: string; attachmentCount: number }) {
  const { t } = useText()
  const { me } = useReference()
  const add = useAddComment(issueId)
  const { upload, pending: uploading } = useUploader(issueId, attachmentCount)
  const [body, setBody] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const tooLong = new TextEncoder().encode(body).length > COMMENT_MAX_BYTES

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

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
      className="flex gap-2"
    >
      <Avatar person={me} size="sm" />
      <div className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white focus-within:border-accent">
        <label htmlFor={`comment-${issueId}`} className="sr-only">
          {t('tracker.comment.label')}
        </label>
        <textarea
          id={`comment-${issueId}`}
          ref={area}
          value={body}
          rows={3}
          placeholder={t('tracker.comment.placeholder')}
          onChange={(event) => setBody(event.target.value)}
          onPaste={onPaste}
          onDrop={(event) => {
            const files = transferFiles(event.dataTransfer)
            if (files.length === 0) return
            event.preventDefault()
            void attachFiles(files)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          aria-invalid={tooLong || undefined}
          className="block max-h-80 min-h-20 w-full resize-y rounded-t-lg bg-transparent px-3 py-2 text-[13px] leading-relaxed text-stone-900 placeholder:text-stone-400 focus:outline-none"
        />
        <div className="flex items-center gap-2 border-t border-stone-100 px-2 py-1.5">
          <span className="text-[11px] text-stone-400">{uploading ? t('tracker.attachment.uploading') : tooLong ? t('tracker.comment.tooLong') : t('tracker.comment.hint')}</span>
          <Button type="submit" size="sm" tone="primary" className="ml-auto h-7 md:h-7" loading={add.isPending} disabled={!body.trim() || tooLong}>
            {t('tracker.comment.send')}
            <Kbd className="border-white/30 bg-white/15 text-white">{`${MOD_KEY}↵`}</Kbd>
          </Button>
        </div>
      </div>
    </form>
  )
}
