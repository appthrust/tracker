// "New issue" (C): project, title, Markdown description, attachments, type
// (epic, story or a work item), parent (only what the hierarchy allows for
// that type), status, priority, assignee, estimate, sprint and labels. The
// project starts as the list/board scope (or the one the opener passes); an
// epic's "New story" or a group's "+" passes the type and parent, a sprint
// section's or sprint page's "+" the sprint. An epic takes no estimate or
// sprint. Choosing "bug" asks for the two required report fields; the full
// report form is `/report` (Shift+R). Files chosen, pasted (a screenshot
// pasted into the description too) or dropped anywhere in the dialog are
// uploaded one by one right after the issue is created; if any fails, the
// dialog stays open naming the issue and the files left out. ⌘/Ctrl+Enter
// creates.
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { sprintsQuery, useCreateIssue } from '../../api/queries'
import type { IssueSummary, IssueType, Priority, Size } from '../../api/tracker'
import { useText } from '../../i18n'
import { ATTACHMENTS_PER_ISSUE, ISSUE_TYPES, PRIORITIES, reportProblems, TITLE_MAX, toReport, type ReportDraft } from '../../model/issues'
import { SIZES } from '../../model/sprints'
import { paths } from '../../routes/paths'
import { ActionError, Button, buttonClasses, Dialog, Field, HrefLink, Kbd, Notice, SelectInput, TextArea, TextInput } from '../../ui'
import { EMPTY_REPORT, ReportFields } from '../report/report-fields'
import { MOD_KEY, setUi, uiStore, useUi, type NewIssueDefaults } from '../ui-state'
import { ColorDot } from './visuals'
import { hierarchyProblem, parentLabel, ParentField } from './hierarchy'
import { ChooseFilesButton, limitsText, PendingPreviews, PendingRefusals, usePendingAttachments } from './pending-attachments'
import { ProjectField } from './projects'
import { assigneeValue, usePeopleOptions } from './properties'
import { useReference } from './use-reference'

export function NewIssueDialog() {
  const defaults = useUi((state) => state.newIssue)
  // Remount per opening so every dialog starts empty with its own defaults.
  return defaults ? <NewIssueForm key={JSON.stringify(defaults)} defaults={defaults} /> : null
}

function NewIssueForm({ defaults: { statusId: initialStatus, projectId: requestedProject, type: initialType, parent: initialParent, sprintId: initialSprint } }: { defaults: NewIssueDefaults }) {
  const { t, locale } = useText()
  const navigate = useNavigate()
  const { statuses, labels, activeProjects } = useReference()
  const create = useCreateIssue()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<IssueType>(initialType ?? 'task')
  const [parent, setParent] = useState<IssueSummary | null>(initialParent ?? null)
  const [statusId, setStatusId] = useState(initialStatus ?? statuses.find((status) => status.category === 'backlog')?.id ?? '')
  const [priority, setPriority] = useState<Priority>('none')
  const [assignee, setAssignee] = useState('')
  const [labelIds, setLabelIds] = useState<string[]>([])
  const [report, setReport] = useState<ReportDraft>(EMPTY_REPORT)
  const [estimate, setEstimate] = useState<Size | ''>('')
  // The opener's sprint, else the sprint screen's (C on a sprint page).
  const [sprintId, setSprintId] = useState(initialSprint ?? uiStore.state.sprintScope ?? '')
  const openSprints = (useQuery(sprintsQuery).data ?? []).filter((sprint) => sprint.state !== 'closed')
  // The opener's choice, else the list/board scope; only an active project counts.
  const [projectId, setProjectId] = useState(() => {
    const initial = requestedProject !== undefined ? requestedProject : uiStore.state.scope
    return initial && activeProjects.some((project) => project.id === initial) ? initial : null
  })
  const [submitted, setSubmitted] = useState(false)
  const people = usePeopleOptions('', true, [])
  const attachments = usePendingAttachments()
  // The created issue when some files could not be attached to it.
  const [result, setResult] = useState<{ identifier: string; failed: string[] } | null>(null)
  // Set before the first await, so neither ⌘/Ctrl+Enter nor Escape can act mid create/upload.
  const busy = useRef(false)
  const pending = create.isPending || attachments.uploading
  const openIssue = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (result) openIssue.current?.focus()
  }, [result])

  const problems = type === 'bug' ? reportProblems(title, report) : !title.trim() ? { title: 'required' as const } : Array.from(title.trim()).length > TITLE_MAX ? { title: 'tooLong' as const } : {}
  const { title: titleProblem, ...reportFieldProblems } = problems
  // A type change can make the chosen parent invalid (a story under a story); creating waits until it is fixed.
  const parentProblem = hierarchyProblem(t, { type }, parent)
  // Lineage-exclusive: the parent already in the chosen sprint keeps its children out (the server checks every depth).
  const sprintProblem = type !== 'epic' && sprintId && parent?.sprint?.id === sprintId ? t('tracker.sprint.problem.lineage') : undefined
  const close = () => setUi({ newIssue: null })

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    setSubmitted(true)
    if (Object.keys(problems).length > 0 || parentProblem || sprintProblem || busy.current) return
    busy.current = true
    try {
      const sub = assigneeValue(assignee || '__none')
      const issue = await create
        .mutateAsync({
          title: title.trim(),
          description: description || undefined,
          type,
          priority,
          statusId: statusId || undefined,
          assigneeSub: sub ?? undefined,
          labelIds: labelIds.length > 0 ? labelIds : undefined,
          parentId: parent?.id,
          projectId: projectId ?? undefined,
          estimate: type !== 'epic' && estimate ? estimate : undefined,
          sprintId: type !== 'epic' && sprintId ? sprintId : undefined,
          report: type === 'bug' ? toReport(report) : undefined,
        })
        .catch(() => undefined)
      if (!issue) return
      // The issue exists from here on: a failed file is reported, never retried by creating again.
      const failed = await attachments.upload(issue.id)
      if (failed.length > 0) return setResult({ identifier: issue.identifier, failed })
      close()
      void navigate({ to: paths.issue(issue.identifier) } as never)
    } finally {
      busy.current = false
    }
  }

  if (result) {
    return (
      <Dialog
        open
        size="lg"
        onOpenChange={(open) => {
          if (!open) close()
        }}
        title={t('tracker.nav.newIssue')}
      >
        <Notice tone="warning" title={t('tracker.attachment.uploadFailedTitle', { identifier: result.identifier })}>
          {t('tracker.report.uploadFailedBody', { files: result.failed.join(', ') })}
        </Notice>
        <div className="mt-4 flex items-center justify-end gap-2 border-t border-stone-100 pt-3">
          <Button onClick={close}>{t('tracker.common.close')}</Button>
          <HrefLink ref={openIssue} href={paths.issue(result.identifier)} onClick={close} className={buttonClasses('primary')}>
            {t('tracker.palette.openIssue', { identifier: result.identifier })}
          </HrefLink>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => {
        if (!open && !busy.current) close()
      }}
      title={t('tracker.nav.newIssue')}
    >
      <form
        noValidate
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void submit()
          }
        }}
        onPaste={attachments.onPaste}
        onDragOver={attachments.onDragOver}
        onDrop={attachments.onDrop}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="new-issue-project" label={t('tracker.project.label')}>
            <ProjectField id="new-issue-project" value={projectId} onChange={setProjectId} />
          </Field>
          <Field id="new-issue-parent" label={parentLabel(t, type)} error={parentProblem} hint={type === 'epic' ? t('tracker.parent.epicTop') : undefined}>
            <ParentField id="new-issue-parent" childType={type} value={type === 'epic' ? null : parent} onChange={setParent} />
          </Field>
        </div>
        <Field
          id="new-issue-title"
          label={t('tracker.issue.title')}
          required
          error={submitted && titleProblem ? (titleProblem === 'required' ? t('tracker.form.required') : t('tracker.form.tooLong', { max: TITLE_MAX })) : undefined}
        >
          <TextInput id="new-issue-title" autoFocus value={title} invalid={submitted && Boolean(titleProblem)} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field id="new-issue-description" label={t('tracker.issue.description')} hint={t('tracker.comment.hint')}>
          <TextArea id="new-issue-description" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <div role="group" aria-labelledby="new-issue-attachments" aria-describedby="new-issue-attachments-hint">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span id="new-issue-attachments" className="text-sm font-medium text-stone-800">
              {t('tracker.attachment.title')}
            </span>
            <span id="new-issue-attachments-hint" className="min-w-0 flex-1 basis-48 text-xs text-stone-500">
              {limitsText(t, locale)}
            </span>
            <span className="text-xs text-stone-500 tabular-nums">
              {attachments.files.length} / {ATTACHMENTS_PER_ISSUE}
            </span>
            <ChooseFilesButton pending={attachments} label={t('tracker.attachment.add')} disabled={create.isPending} />
          </div>
          <PendingPreviews pending={attachments} className="mt-2" />
          <PendingRefusals pending={attachments} className="mt-1.5" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="new-issue-type" label={t('tracker.property.type')}>
            <SelectInput
              id="new-issue-type"
              value={type}
              onChange={(event) => {
                const next = event.target.value as IssueType
                setType(next)
                // An epic has no parent; the field shows that instead of the old choice.
                if (next === 'epic') setParent(null)
              }}
            >
              {ISSUE_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`tracker.type.${value}`)}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field id="new-issue-status" label={t('tracker.property.status')}>
            <SelectInput id="new-issue-status" value={statusId} onChange={(event) => setStatusId(event.target.value)}>
              {statuses.map((status) => (
                <option key={status.id} value={status.id}>
                  {status.name}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field id="new-issue-priority" label={t('tracker.property.priority')}>
            <SelectInput id="new-issue-priority" value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
              {PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {t(`tracker.priority.${value}`)}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field id="new-issue-assignee" label={t('tracker.property.assignee')}>
            <SelectInput id="new-issue-assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
              {people.options
                .filter((option) => !option.value.startsWith('agent:'))
                .map((option) => (
                  <option key={option.value} value={option.value === '__none' ? '' : option.value}>
                    {option.label}
                  </option>
                ))}
              {people.options.some((option) => option.value.startsWith('agent:')) ? (
                <optgroup label={t('tracker.agent.delegate')}>
                  {people.options
                    .filter((option) => option.value.startsWith('agent:'))
                    .map((option) => (
                      <option key={option.value} value={option.value}>
                        {`${option.label} (${option.detail})`}
                      </option>
                    ))}
                </optgroup>
              ) : null}
            </SelectInput>
          </Field>
          <Field id="new-issue-estimate" label={t('tracker.property.estimate')} hint={type === 'epic' ? t('tracker.estimate.epic') : undefined}>
            <SelectInput id="new-issue-estimate" value={type === 'epic' ? '' : estimate} disabled={type === 'epic'} onChange={(event) => setEstimate(event.target.value as Size | '')}>
              <option value="">{t('tracker.estimate.none')}</option>
              {SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field id="new-issue-sprint" label={t('tracker.property.sprint')} error={sprintProblem} hint={type === 'epic' ? t('tracker.sprint.problem.epic') : undefined}>
            <SelectInput id="new-issue-sprint" value={type === 'epic' ? '' : sprintId} disabled={type === 'epic'} invalid={Boolean(sprintProblem)} onChange={(event) => setSprintId(event.target.value)}>
              <option value="">{t('tracker.sprint.backlog')}</option>
              {openSprints.map((sprint) => (
                <option key={sprint.id} value={sprint.id}>
                  {`${sprint.name} · ${t(`tracker.sprint.state.${sprint.state}`)}`}
                </option>
              ))}
            </SelectInput>
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="text-sm font-medium text-stone-800">{t('tracker.property.labels')}</legend>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {labels.map((label) => {
                const on = labelIds.includes(label.id)
                return (
                  <label key={label.id} className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs ${on ? 'border-accent-line bg-accent-soft text-accent-strong' : 'border-line text-stone-600 hover:bg-stone-50'}`}>
                    <input type="checkbox" className="sr-only" checked={on} onChange={() => setLabelIds(on ? labelIds.filter((id) => id !== label.id) : [...labelIds, label.id])} />
                    <ColorDot color={label.color} className="size-2" />
                    {label.name}
                  </label>
                )
              })}
            </div>
          </fieldset>
        </div>
        {type === 'bug' ? (
          <div className="rounded-lg border border-red-100 bg-red-50/40 p-3">
            <ReportFields draft={report} onChange={setReport} problems={submitted ? reportFieldProblems : {}} compact />
            <p className="mt-2 text-xs text-stone-500">
              {t('tracker.newIssue.fullReport')}{' '}
              <HrefLink
                href={paths.report}
                aria-disabled={pending || undefined}
                onClick={(event) => {
                  // Leaving mid create/upload would drop the files still to send and the failure result.
                  if (busy.current) return event.preventDefault()
                  close()
                }}
                className="font-medium text-accent-strong underline aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
              >
                {t('tracker.nav.report')}
              </HrefLink>
            </p>
          </div>
        ) : null}
        {create.error ? <ActionError error={create.error} /> : null}
        {/* Stays in view while the dialog scrolls, so a long form (or many previews) never hides Create. */}
        <div className="sticky bottom-0 -mb-5 flex items-center justify-end gap-2 border-t border-stone-100 bg-white pt-3 pb-5">
          <Button onClick={close} disabled={pending}>
            {t('tracker.common.cancel')}
          </Button>
          <Button type="submit" tone="primary" loading={pending}>
            {attachments.progress ? t('tracker.attachment.uploadingProgress', attachments.progress) : t('tracker.newIssue.create')}
            <Kbd className="border-white/30 bg-white/15 text-white">{`${MOD_KEY}↵`}</Kbd>
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
