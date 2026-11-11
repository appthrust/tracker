// One issue: breadcrumb (epic › story › parent), title, the agent's live run
// and the open requests (pinned above the description, answerable in place),
// Markdown description, bug report fields, an epic's or story's children with
// progress, relations, attachments, timeline and comment box, with a
// properties sidebar (parent, estimate, sprint and, for an agent assignee, the
// person who delegated it). Title and description edits carry the
// `updatedAt` they were made against: if someone else wrote in between, the
// draft stays and a notice offers to load the latest version instead of
// overwriting it. Rendered as the full page (`/issues/APT-12`) or as the side
// panel over a list.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Bug, Copy, Maximize2, Pencil, RotateCw, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import { issueQuery, timelineQuery, useDeleteIssue, useUpdateIssue } from '../../api/queries'
import { isTrackerError, type Issue, type Report, type TrackerRequest, type UpdateIssueInput } from '../../api/tracker'
import { useText } from '../../i18n'
import { attachmentsOf, levelOf, reportProblems, toReport, TITLE_MAX, type ReportDraft } from '../../model/issues'
import { paths } from '../../routes/paths'
import { Button, cn, ConfirmDialog, EmptyState, errorDetail, errorMessageId, formatDate, formatDateTime, formatRelative, HrefLink, Loading, LoadFailed, Markdown, Notice, showToast, TextArea, useDocumentTitle } from '../../ui'
import { ActorAvatar, ActorName } from '../agents/actor'
import { RequestCard } from '../agents/request-card'
import { RunBlock } from '../agents/run-block'
import { setUi } from '../ui-state'
import { ReportFields, type ReportProblems } from '../report/report-fields'
import { Attachments, markdownFor, transferFiles, useUploader } from './attachments'
import { HierarchySection, IssueBreadcrumb, IssueParentPicker, parentLabel } from './hierarchy'
import { AssigneePicker, EstimatePicker, IssueProjectPicker, LabelsPicker, PriorityPicker, SprintPicker, StatusPicker, TypePicker, useIssueEditor } from './properties'
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
  const openRequests = items.flatMap((item): TrackerRequest[] => (item.kind === 'request' && item.request.state === 'open' ? [item.request] : []))
  const main = (
    <div className="min-w-0 flex-1 space-y-8">
      <div>
        <TitleEditor issue={data} variant={variant} />
        {data.activeRun || openRequests.length > 0 ? (
          <div className="mt-4 space-y-3">
            {data.activeRun ? <RunBlock run={data.activeRun} /> : null}
            {openRequests.length > 0 ? (
              <section aria-labelledby={`requests-${data.id}`} className="space-y-2">
                <h2 id={`requests-${data.id}`} className="text-xs font-medium text-stone-500">
                  {t('tracker.request.pinned')} <span className="text-stone-400 tabular-nums">{openRequests.length}</span>
                </h2>
                {openRequests.map((request) => (
                  <RequestCard key={request.id} request={request} variant="pinned" />
                ))}
              </section>
            ) : null}
          </div>
        ) : null}
        <DescriptionEditor issue={data} attachmentCount={attachments.length} />
      </div>
      {data.report ? <ReportSection issue={data} report={data.report} /> : null}
      {levelOf(data.type) > 0 ? <HierarchySection issue={data} /> : null}
      <Relations issue={data} />
      <Attachments issueId={data.id} attachments={attachments} />
      <section aria-labelledby={`activity-${data.id}`} className="space-y-4">
        <h2 id={`activity-${data.id}`} className="text-xs font-medium text-stone-500">
          {t('tracker.issue.activity')}
        </h2>
        {timeline.isPending ? <Loading /> : timeline.isError ? <LoadFailed error={timeline.error} onRetry={() => void timeline.refetch()} /> : <Timeline issueId={data.id} items={items.filter((item) => !(item.kind === 'request' && item.request.state === 'open'))} />}
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

/**
 * Title and description writes guarded by the revision the draft was started
 * from: `begin()` records `updatedAt` when the editor opens and every save
 * sends that, so a change someone else made meanwhile — even one the 15 s
 * refetch already brought into this screen — is a 409, never a silent
 * overwrite. A 409 keeps the draft (`onConflict`) and the editor shows the
 * conflict notice; only the explicit "Load latest" moves the base to the
 * fetched revision. Other refusals toast like every other edit.
 */
function useGuardedEdit(issue: Issue) {
  const { t } = useText()
  const mutation = useUpdateIssue()
  const client = useQueryClient()
  const [conflict, setConflict] = useState(false)
  const [base, setBase] = useState<string | null>(null)
  const begin = () => {
    setConflict(false)
    setBase(issue.updatedAt)
  }
  const save = (input: UpdateIssueInput, onConflict: () => void) => {
    setConflict(false)
    mutation.mutate(
      { id: issue.id, input: { ...input, expectedUpdatedAt: base ?? issue.updatedAt } },
      {
        onSuccess: () => setBase(null),
        onError: (error) => {
          if (isTrackerError(error, 'conflict')) {
            setConflict(true)
            onConflict()
            return
          }
          const known = errorMessageId(error)
          showToast({ tone: 'error', title: t('tracker.issue.saveFailed'), detail: [known ? t(known) : undefined, errorDetail(error)].filter(Boolean).join(' ') || undefined })
        },
      }
    )
  }
  const reload = () => {
    setConflict(false)
    void client.invalidateQueries({ queryKey: timelineQuery(issue.id).queryKey })
    void client.fetchQuery({ ...issueQuery(issue.identifier), staleTime: 0 }).then((fresh) => setBase(fresh.updatedAt))
  }
  const dismiss = () => {
    setConflict(false)
    setBase(null)
  }
  return { begin, save, conflict, reload, dismiss }
}

function ConflictNotice({ onReload }: { onReload: () => void }) {
  const { t } = useText()
  return (
    <Notice
      tone="warning"
      title={t('tracker.issue.conflictTitle')}
      actions={
        <Button size="sm" icon={<RotateCw />} onClick={onReload}>
          {t('tracker.issue.conflictReload')}
        </Button>
      }
    >
      {t('tracker.issue.conflictBody')}
    </Notice>
  )
}

function TitleEditor({ issue, variant }: { issue: Issue; variant: Variant }) {
  const { t } = useText()
  const guarded = useGuardedEdit(issue)
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
    guarded.save({ title }, () => setEditing(true))
  }
  const Heading = variant === 'page' ? 'h1' : 'h2'
  return (
    <div>
      <IssueBreadcrumb issue={issue} />
      {/* With a parent the breadcrumb already ends in the identifier. */}
      {variant === 'page' && !issue.parent ? <p className="font-mono text-xs text-stone-500">{issue.identifier}</p> : null}
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
              guarded.dismiss()
            }
          }}
          className="mt-1 block w-full rounded-md border border-accent px-2 py-1 text-xl font-semibold text-stone-900 focus:outline-none"
        />
      ) : (
        <Heading className="mt-1">
          <button
            type="button"
            onClick={() => (setDraft(issue.title), guarded.begin(), setEditing(true))}
            title={t('tracker.issue.editTitle')}
            className="-mx-2 block w-[calc(100%+1rem)] rounded-md px-2 py-1 text-left text-xl leading-snug font-semibold text-stone-900 hover:bg-stone-50"
          >
            {issue.title}
          </button>
        </Heading>
      )}
      {guarded.conflict ? <ConflictNotice onReload={guarded.reload} /> : null}
    </div>
  )
}

function DescriptionEditor({ issue, attachmentCount }: { issue: Issue; attachmentCount: number }) {
  const { t } = useText()
  const guarded = useGuardedEdit(issue)
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
    if (draft !== issue.description) guarded.save({ description: draft }, () => setEditing(true))
  }
  if (editing) {
    return (
      <div className="mt-3 space-y-2">
        {guarded.conflict ? <ConflictNotice onReload={guarded.reload} /> : null}
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
              guarded.dismiss()
            }
          }}
          className="font-mono text-[13px]"
        />
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-stone-400">{pending ? t('tracker.attachment.uploading') : t('tracker.comment.hint')}</span>
          <Button size="sm" onClick={() => (setEditing(false), setDraft(issue.description), guarded.dismiss())}>
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
        onClick={() => (setDraft(issue.description), guarded.begin(), setEditing(true))}
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
  const { t } = useText()
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-line px-1.5 py-1">
      <div className="w-40">
        <StatusPicker issue={issue} variant="row" />
      </div>
      <div className="w-32">
        <PriorityPicker issue={issue} variant="row" />
      </div>
      <div className="w-56">
        <AssigneePicker issue={issue} variant="row" />
        {issue.delegator ? <p className="px-2 pb-0.5 text-[11px] text-stone-500">{t('tracker.agent.delegatedBy', { name: issue.delegator.name })}</p> : null}
      </div>
      <div className="w-44">
        <IssueProjectPicker issue={issue} variant="row" />
      </div>
      <div className="w-36">
        <TypePicker issue={issue} />
      </div>
      <div className="w-56" role="group" aria-label={parentLabel(t, issue.type)}>
        <IssueParentPicker issue={issue} />
      </div>
      <div className="w-32">
        <EstimatePicker issue={issue} variant="row" />
      </div>
      <div className="w-40">
        <SprintPicker issue={issue} variant="row" />
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
      {issue.assignee?.kind === 'agent' && issue.assignee.agent ? row('', <p className="px-2 text-[11px] text-stone-500">{t('tracker.agent.ownedBy', { name: issue.assignee.agent.owner.name })}</p>) : null}
      {issue.delegator ? row(t('tracker.property.delegator'), <span className="flex items-center gap-2 px-2 text-[13px] text-stone-700"><ActorAvatar actor={{ ...issue.delegator, kind: 'person' }} />{issue.delegator.name}</span>) : null}
      {row(t('tracker.property.labels'), <LabelsPicker issue={issue} variant="row" />)}
      {row(t('tracker.property.type'), <TypePicker issue={issue} />)}
      {row(parentLabel(t, issue.type), <IssueParentPicker issue={issue} />)}
      {row(t('tracker.property.estimate'), <EstimatePicker issue={issue} variant="row" />)}
      {row(t('tracker.property.sprint'), <SprintPicker issue={issue} variant="row" />)}
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
      {row(t('tracker.property.reporter'), <span className="flex min-w-0 items-center gap-2 px-2 text-[13px] text-stone-700"><ActorAvatar actor={issue.reporter} /><ActorName actor={issue.reporter} /></span>)}
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
