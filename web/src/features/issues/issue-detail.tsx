// One issue: title, Markdown description, bug report fields, relations,
// attachments, timeline and comment box, with a properties sidebar. Rendered
// as the full page (`/issues/APT-12`) or as the side panel over a list.
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Bug, Copy, Maximize2, Pencil, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import { issueQuery, timelineQuery, useDeleteIssue } from '../../api/queries'
import { isTrackerError, type Issue, type Report } from '../../api/tracker'
import { useText } from '../../i18n'
import { attachmentsOf, reportProblems, toReport, TITLE_MAX, type ReportDraft } from '../../model/issues'
import { paths } from '../../routes/paths'
import { Button, cn, ConfirmDialog, EmptyState, formatDate, formatDateTime, formatRelative, HrefLink, Loading, LoadFailed, Markdown, showToast, TextArea, useDocumentTitle } from '../../ui'
import { setUi } from '../ui-state'
import { ReportFields, type ReportProblems } from '../report/report-fields'
import { Attachments, markdownFor, transferFiles, useUploader } from './attachments'
import { AssigneePicker, IssueProjectPicker, LabelsPicker, PriorityPicker, StatusPicker, TypePicker, useIssueEditor } from './properties'
import { Relations } from './relations'
import { CommentComposer, insertAtCaret, Timeline } from './timeline'
import { useReference } from './use-reference'

type Variant = 'page' | 'panel'

/** Loads the issue (and its timeline) and renders it; 404 renders a not-found notice. */
function useIssue(identifier: string) {
  const issue = useQuery(issueQuery(identifier))
  const timeline = useQuery({ ...timelineQuery(issue.data?.id ?? ''), enabled: issue.data !== undefined })
  return { issue, timeline }
}

export function IssuePage({ identifier }: { identifier: string }) {
  const { issue } = useIssue(identifier)
  useDocumentTitle(issue.data ? `${issue.data.identifier} ${issue.data.title}` : identifier.toUpperCase())
  useEffect(() => {
    if (issue.data) setUi({ context: [issue.data], focusedId: issue.data.id, selectedIds: [] })
  }, [issue.data])
  useEffect(() => () => setUi({ context: [], focusedId: null }), [])
  return (
    <div className="h-full overflow-y-auto">
      <IssueDetail identifier={identifier} variant="page" />
    </div>
  )
}

export function IssuePanel({ identifier, onClose }: { identifier: string; onClose: () => void }) {
  const { t } = useText()
  return (
    <aside
      aria-label={t('tracker.issue.panel', { identifier: identifier.toUpperCase() })}
      className="absolute inset-y-0 right-0 z-10 flex w-full flex-col border-l border-line bg-white shadow-[-8px_0_24px_-12px_rgb(0_0_0/0.15)] animate-fade-in sm:w-[min(640px,85%)]"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-3">
        <span className="font-mono text-xs text-stone-500">{identifier.toUpperCase()}</span>
        <HrefLink
          href={paths.issue(identifier.toUpperCase())}
          title={t('tracker.issue.openFull')}
          aria-label={t('tracker.issue.openFull')}
          className="ml-auto flex size-7 items-center justify-center rounded text-stone-500 hover:bg-stone-100 hover:text-stone-900"
        >
          <Maximize2 aria-hidden className="size-3.5" />
        </HrefLink>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('tracker.issue.closePanel')}
          title={`${t('tracker.issue.closePanel')} (Esc)`}
          className="flex size-7 items-center justify-center rounded text-stone-500 hover:bg-stone-100 hover:text-stone-900"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <IssueDetail identifier={identifier} variant="panel" />
      </div>
    </aside>
  )
}

function IssueDetail({ identifier, variant }: { identifier: string; variant: Variant }) {
  const { t } = useText()
  const { issue, timeline } = useIssue(identifier)
  if (issue.isPending) return <Loading className="px-6" />
  if (issue.isError) {
    if (isTrackerError(issue.error, 'not_found'))
      return (
        <div className="p-6">
          <EmptyState title={t('tracker.issue.notFoundTitle', { identifier: identifier.toUpperCase() })} body={t('tracker.issue.notFoundBody')} />
        </div>
      )
    return (
      <div className="p-6">
        <LoadFailed error={issue.error} onRetry={() => void issue.refetch()} />
      </div>
    )
  }
  const data = issue.data
  const items = timeline.data ?? []
  const attachments = attachmentsOf(items)
  const main = (
    <div className="min-w-0 flex-1 space-y-8">
      <div>
        <TitleEditor issue={data} variant={variant} />
        <DescriptionEditor issue={data} attachmentCount={attachments.length} />
      </div>
      {data.report ? <ReportSection issue={data} report={data.report} /> : null}
      <Relations issue={data} />
      <Attachments issueId={data.id} attachments={attachments} />
      <section aria-labelledby={`activity-${data.id}`} className="space-y-4">
        <h2 id={`activity-${data.id}`} className="text-xs font-medium text-stone-500">
          {t('tracker.issue.activity')}
        </h2>
        {timeline.isPending ? <Loading /> : timeline.isError ? <LoadFailed error={timeline.error} onRetry={() => void timeline.refetch()} /> : <Timeline issueId={data.id} items={items} />}
        <CommentComposer issueId={data.id} attachmentCount={attachments.length} />
      </section>
    </div>
  )
  if (variant === 'panel') {
    return (
      <div className="space-y-6 px-5 py-4">
        <PropertiesBar issue={data} />
        {main}
      </div>
    )
  }
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-6 sm:px-8 lg:flex-row lg:gap-10">
      {main}
      <aside aria-label={t('tracker.issue.properties')} className="lg:sticky lg:top-6 lg:w-64 lg:shrink-0 lg:self-start">
        <PropertiesSidebar issue={data} />
      </aside>
    </div>
  )
}

function TitleEditor({ issue, variant }: { issue: Issue; variant: Variant }) {
  const { t } = useText()
  const { update } = useIssueEditor()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(issue.title)
  const save = () => {
    const title = draft.trim()
    setEditing(false)
    if (!title || title === issue.title) return setDraft(issue.title)
    if (Array.from(title).length > TITLE_MAX) {
      setDraft(issue.title)
      return showToast({ tone: 'error', title: t('tracker.issue.saveFailed'), detail: t('tracker.form.tooLong', { max: TITLE_MAX }) })
    }
    update({ id: issue.id, input: { title } })
  }
  const Heading = variant === 'page' ? 'h1' : 'h2'
  return (
    <div>
      {issue.parent ? (
        <HrefLink href={paths.issue(issue.parent.identifier)} className="mb-1 inline-flex max-w-full items-center gap-1 text-xs text-stone-500 hover:text-stone-900">
          <span className="font-mono">{issue.parent.identifier}</span>
          <span className="truncate">{issue.parent.title}</span>
          <span aria-hidden>›</span>
        </HrefLink>
      ) : null}
      {variant === 'page' ? <p className="font-mono text-xs text-stone-500">{issue.identifier}</p> : null}
      {editing ? (
        <input
          autoFocus
          aria-label={t('tracker.issue.title')}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') save()
            if (event.key === 'Escape') {
              event.stopPropagation()
              setDraft(issue.title)
              setEditing(false)
            }
          }}
          className="mt-1 block w-full rounded-md border border-accent px-2 py-1 text-xl font-semibold text-stone-900 focus:outline-none"
        />
      ) : (
        <Heading className="mt-1">
          <button
            type="button"
            onClick={() => (setDraft(issue.title), setEditing(true))}
            title={t('tracker.issue.editTitle')}
            className="-mx-2 block w-[calc(100%+1rem)] rounded-md px-2 py-1 text-left text-xl leading-snug font-semibold text-stone-900 hover:bg-stone-50"
          >
            {issue.title}
          </button>
        </Heading>
      )}
    </div>
  )
}

function DescriptionEditor({ issue, attachmentCount }: { issue: Issue; attachmentCount: number }) {
  const { t } = useText()
  const { update } = useIssueEditor()
  const { upload, pending } = useUploader(issue.id, attachmentCount)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(issue.description)
  const area = useRef<HTMLTextAreaElement>(null)
  const attachFiles = async (files: File[]) => {
    const done = await upload(files)
    if (done.length > 0) setDraft((current) => insertAtCaret(area.current, current, done.map(markdownFor).join('\n')))
  }
  const save = () => {
    setEditing(false)
    if (draft !== issue.description) update({ id: issue.id, input: { description: draft } })
  }
  if (editing) {
    return (
      <div className="mt-3 space-y-2">
        <TextArea
          ref={area}
          autoFocus
          aria-label={t('tracker.issue.description')}
          value={draft}
          rows={8}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
            const files = transferFiles(event.clipboardData)
            if (files.length === 0) return
            event.preventDefault()
            void attachFiles(files)
          }}
          onDrop={(event: DragEvent<HTMLTextAreaElement>) => {
            const files = transferFiles(event.dataTransfer)
            if (files.length === 0) return
            event.preventDefault()
            void attachFiles(files)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save()
            if (event.key === 'Escape') {
              event.stopPropagation()
              setEditing(false)
              setDraft(issue.description)
            }
          }}
          className="font-mono text-[13px]"
        />
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-stone-400">{pending ? t('tracker.attachment.uploading') : t('tracker.comment.hint')}</span>
          <Button size="sm" onClick={() => (setEditing(false), setDraft(issue.description))}>
            {t('tracker.common.cancel')}
          </Button>
          <Button size="sm" tone="primary" onClick={save}>
            {t('tracker.common.save')}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="group relative mt-3">
      {issue.description ? (
        <Markdown source={issue.description} className="text-sm leading-relaxed [&>*+*]:mt-3" />
      ) : (
        <p className="text-sm text-stone-400">{t('tracker.issue.noDescription')}</p>
      )}
      <button
        type="button"
        onClick={() => (setDraft(issue.description), setEditing(true))}
        className="mt-2 inline-flex h-7 items-center gap-1 rounded px-1.5 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-900"
      >
        <Pencil aria-hidden className="size-3" />
        {issue.description ? t('tracker.issue.editDescription') : t('tracker.issue.addDescription')}
      </button>
    </div>
  )
}

const draftOf = (report: Report): ReportDraft => ({
  environment: report.environment,
  surface: report.surface,
  version: report.version ?? '',
  steps: report.steps ?? '',
  expected: report.expected ?? '',
  actual: report.actual ?? '',
})

function ReportSection({ issue, report }: { issue: Issue; report: Report }) {
  const { t } = useText()
  const { update } = useIssueEditor()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => draftOf(report))
  const [problems, setProblems] = useState<ReportProblems>({})
  const row = (label: string, value: ReactNode, wide = false) => (
    <div className={cn('min-w-0', wide && 'sm:col-span-3')}>
      <dt className="text-[11px] font-medium text-stone-500">{label}</dt>
      <dd className={cn('mt-0.5 text-[13px] break-words text-stone-800', wide && 'whitespace-pre-wrap')}>{value || <span className="text-stone-400">—</span>}</dd>
    </div>
  )
  return (
    <section aria-labelledby={`report-${issue.id}`} className="rounded-lg border border-red-100 bg-red-50/40 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Bug aria-hidden className="size-3.5 text-red-500" />
        <h2 id={`report-${issue.id}`} className="text-xs font-semibold text-stone-700">
          {t('tracker.report.section')}
        </h2>
        {!editing ? (
          <button type="button" onClick={() => (setDraft(draftOf(report)), setProblems({}), setEditing(true))} className="ml-auto inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-stone-500 hover:bg-white hover:text-stone-900">
            <Pencil aria-hidden className="size-3" />
            {t('tracker.report.edit')}
          </button>
        ) : null}
      </div>
      {editing ? (
        <form
          className="space-y-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            const { title: _title, ...found } = reportProblems(issue.title, draft)
            setProblems(found)
            if (Object.keys(found).length > 0) return
            update({ id: issue.id, input: { report: toReport(draft) } })
            setEditing(false)
          }}
        >
          <ReportFields draft={draft} onChange={setDraft} problems={problems} />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setEditing(false)}>
              {t('tracker.common.cancel')}
            </Button>
            <Button size="sm" tone="primary" type="submit">
              {t('tracker.common.save')}
            </Button>
          </div>
        </form>
      ) : (
        <dl className="grid gap-3 sm:grid-cols-3">
          {row(t('tracker.report.environment'), report.environment)}
          {row(t('tracker.report.surface'), t(`tracker.surface.${report.surface}`))}
          {row(t('tracker.report.version'), report.version)}
          {row(t('tracker.report.steps'), report.steps, true)}
          {row(t('tracker.report.expected'), report.expected, true)}
          {row(t('tracker.report.actual'), report.actual, true)}
        </dl>
      )}
    </section>
  )
}

/** Compact property strip at the top of the side panel. */
function PropertiesBar({ issue }: { issue: Issue }) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-line px-1.5 py-1">
      <div className="w-40">
        <StatusPicker issue={issue} variant="row" />
      </div>
      <div className="w-32">
        <PriorityPicker issue={issue} variant="row" />
      </div>
      <div className="w-40">
        <AssigneePicker issue={issue} variant="row" />
      </div>
      <div className="w-44">
        <IssueProjectPicker issue={issue} variant="row" />
      </div>
      <div className="min-w-32 flex-1">
        <LabelsPicker issue={issue} variant="row" />
      </div>
    </div>
  )
}

function PropertiesSidebar({ issue }: { issue: Issue }) {
  const { t, locale } = useText()
  const { me } = useReference()
  const { update } = useIssueEditor()
  const navigate = useNavigate()
  const remove = useDeleteIssue()
  const [confirming, setConfirming] = useState(false)
  const row = (label: string, control: ReactNode) => (
    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-1">
      <span className="text-xs text-stone-500">{label}</span>
      <div className="min-w-0">{control}</div>
    </div>
  )
  const stamp = (iso: string) => (
    <time dateTime={iso} title={formatDateTime(iso, locale)} className="px-2 text-[13px] text-stone-700">
      {formatRelative(iso, locale)}
    </time>
  )
  return (
    <div className="space-y-1">
      {row(t('tracker.property.status'), <StatusPicker issue={issue} variant="row" />)}
      {row(t('tracker.project.label'), <IssueProjectPicker issue={issue} variant="row" />)}
      {row(t('tracker.property.priority'), <PriorityPicker issue={issue} variant="row" />)}
      {row(t('tracker.property.assignee'), <AssigneePicker issue={issue} variant="row" />)}
      {row(t('tracker.property.labels'), <LabelsPicker issue={issue} variant="row" />)}
      {row(t('tracker.property.type'), <TypePicker issue={issue} />)}
      {row(
        t('tracker.property.due'),
        <input
          type="date"
          aria-label={t('tracker.property.due')}
          value={issue.dueOn ?? ''}
          onChange={(event) => update({ id: issue.id, input: { dueOn: event.target.value || null } })}
          className="h-8 w-full rounded-md border border-transparent bg-transparent px-2 text-[13px] text-stone-800 hover:bg-stone-100 focus:border-accent focus:outline-none"
        />
      )}
      <div className="my-3 border-t border-line" />
      {row(t('tracker.property.reporter'), <span className="px-2 text-[13px] text-stone-700">{issue.reporter.name}</span>)}
      {row(t('tracker.property.created'), stamp(issue.createdAt))}
      {row(t('tracker.property.updated'), stamp(issue.updatedAt))}
      {issue.completedAt ? row(t('tracker.property.completed'), <span className="px-2 text-[13px] text-stone-700">{formatDate(issue.completedAt, locale)}</span>) : null}
      <div className="my-3 border-t border-line" />
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          tone="ghost"
          icon={<Copy />}
          onClick={() =>
            void navigator.clipboard
              .writeText(`${location.origin}${paths.issue(issue.identifier)}`)
              .then(() => showToast({ tone: 'success', title: t('tracker.issue.linkCopied') }))
              .catch(() => showToast({ tone: 'error', title: t('tracker.common.actionFailed') }))
          }
        >
          {t('tracker.issue.copyLink')}
        </Button>
        {me.isAdmin ? (
          <Button size="sm" tone="ghost" icon={<Trash2 />} onClick={() => setConfirming(true)} className="text-bad-ink hover:bg-bad-soft hover:text-bad-ink">
            {t('tracker.issue.delete')}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('tracker.issue.deleteTitle', { identifier: issue.identifier })}
        body={t('tracker.issue.deleteBody')}
        confirmLabel={t('tracker.issue.delete')}
        tone="danger"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate(issue.id, { onSuccess: () => void navigate({ to: paths.home } as never) })}
      />
    </div>
  )
}
