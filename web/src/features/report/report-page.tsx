// `/report`: the bug report form. Creates a `type=bug` issue with the
// AppThrust report fields (and a project, starting as the list/board scope),
// uploads the pasted/dropped screenshots to it, and lands on the new issue
// with a toast linking to "Reported by me" (`/reported`). `?version=` (from a
// link on a release page) prefills the version.
import { useNavigate } from '@tanstack/react-router'
import { Bug } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import type { Priority } from '../../api/tracker'
import { useCreateIssue } from '../../api/queries'
import { useText } from '../../i18n'
import { ATTACHMENTS_PER_ISSUE, PRIORITIES, reportProblems, TITLE_MAX, toReport, type ReportDraft } from '../../model/issues'
import { paths } from '../../routes/paths'
import { ActionError, Button, cn, Field, HrefLink, Kbd, Notice, SelectInput, showToast, TextInput, useDocumentTitle } from '../../ui'
import { ChooseFilesButton, PendingPreviews, PendingRefusals, usePendingAttachments } from '../issues/pending-attachments'
import { ProjectField } from '../issues/projects'
import { useReference } from '../issues/use-reference'
import { MOD_KEY, uiStore } from '../ui-state'
import { EMPTY_REPORT, ReportFields, type ReportProblems } from './report-fields'

export function ReportPage({ version }: { version?: string }) {
  const { t } = useText()
  useDocumentTitle(t('tracker.nav.report'))
  const navigate = useNavigate()
  const create = useCreateIssue()
  const id = useId()
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const { activeProjects } = useReference()
  const [projectId, setProjectId] = useState<string | null>(() => activeProjects.find((project) => project.id === uiStore.state.scope)?.id ?? null)
  const [draft, setDraft] = useState<ReportDraft>({ ...EMPTY_REPORT, version: version ?? '' })
  const shots = usePendingAttachments()
  const [submitted, setSubmitted] = useState(false)
  const [uploadFailure, setUploadFailure] = useState<{ identifier: string; failed: string[] } | null>(null)

  const all = reportProblems(title, draft)
  const { title: titleProblem, ...fieldProblems } = all
  const shown: ReportProblems = submitted ? fieldProblems : {}

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    setSubmitted(true)
    if (Object.keys(all).length > 0 || create.isPending || shots.uploading) return
    const issue = await create.mutateAsync({ title: title.trim(), type: 'bug', priority, report: toReport(draft), projectId: projectId ?? undefined }).catch(() => undefined)
    if (!issue) return
    const failed = await shots.upload(issue.id)
    if (failed.length > 0) return setUploadFailure({ identifier: issue.identifier, failed })
    void navigate({ to: paths.issue(issue.identifier) } as never)
    showToast({ tone: 'success', title: t('tracker.report.submitted', { identifier: issue.identifier }), action: { label: t('tracker.report.seeReported'), href: paths.reported } })
  }

  if (uploadFailure) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <Notice
          tone="warning"
          title={t('tracker.report.uploadFailedTitle', { identifier: uploadFailure.identifier })}
          actions={
            <>
              <HrefLink href={paths.issue(uploadFailure.identifier)} className="text-sm font-medium underline">
                {t('tracker.palette.openIssue', { identifier: uploadFailure.identifier })}
              </HrefLink>
              <HrefLink href={paths.reported} className="text-sm font-medium underline">
                {t('tracker.report.seeReported')}
              </HrefLink>
            </>
          }
        >
          {t('tracker.report.uploadFailedBody', { files: uploadFailure.failed.join(', ') })}
        </Notice>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto" onPaste={shots.onPaste}>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
        <header className="mb-6">
          <p className="flex items-center gap-1.5 text-xs font-medium text-red-600">
            <Bug aria-hidden className="size-3.5" />
            {t('tracker.type.bug')}
          </p>
          <h1 className="mt-1 text-xl font-semibold text-stone-900">{t('tracker.nav.report')}</h1>
          <p className="mt-1 text-sm text-stone-500">{t('tracker.report.lead')}</p>
        </header>
        <form
          noValidate
          onSubmit={(event) => void submit(event)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit()
            }
          }}
          className="space-y-6"
        >
          <Field
            id={`${id}-title`}
            label={t('tracker.report.titleLabel')}
            required
            error={submitted && titleProblem ? (titleProblem === 'required' ? t('tracker.form.required') : t('tracker.form.tooLong', { max: TITLE_MAX })) : undefined}
            aside={`${Array.from(title.trim()).length} / ${TITLE_MAX}`}
          >
            <TextInput id={`${id}-title`} autoFocus value={title} invalid={submitted && Boolean(titleProblem)} onChange={(event) => setTitle(event.target.value)} placeholder={t('tracker.report.titlePlaceholder')} />
          </Field>
          <ReportFields draft={draft} onChange={setDraft} problems={shown} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={`${id}-project`} label={t('tracker.project.label')}>
              <ProjectField id={`${id}-project`} value={projectId} onChange={setProjectId} />
            </Field>
            <Field id={`${id}-priority`} label={t('tracker.property.priority')}>
              <SelectInput id={`${id}-priority`} value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
                {PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {t(`tracker.priority.${value}`)}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span id={`${id}-shots`} className="text-sm font-medium text-stone-800">
                {t('tracker.report.screenshots')}
              </span>
              <span className="text-xs text-stone-500 tabular-nums">
                {shots.files.length} / {ATTACHMENTS_PER_ISSUE}
              </span>
            </div>
            <div
              role="group"
              aria-labelledby={`${id}-shots`}
              onDragOver={shots.onDragOver}
              onDrop={shots.onDrop}
              className={cn('mt-1.5 rounded-lg border border-dashed border-stone-300 bg-white p-3', shots.files.length === 0 && 'py-6')}
            >
              <PendingPreviews pending={shots} className="mb-3" />
              <div className="flex flex-col items-center gap-2 text-center text-xs text-stone-500 sm:flex-row sm:justify-center">
                <span>{t('tracker.report.screenshotsHint', { mod: MOD_KEY })}</span>
                <ChooseFilesButton pending={shots} label={t('tracker.report.chooseFile')} />
              </div>
            </div>
            <PendingRefusals pending={shots} className="mt-1.5" />
          </div>

          {create.error ? <ActionError error={create.error} /> : null}
          {submitted && Object.keys(all).length > 0 ? (
            <p role="alert" className="text-xs text-bad-ink">
              {t('tracker.form.fixErrors')}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
            <HrefLink href={paths.home} className="text-sm text-stone-600 hover:text-stone-900">
              {t('tracker.common.cancel')}
            </HrefLink>
            <Button type="submit" tone="primary" loading={create.isPending || shots.uploading}>
              {shots.uploading ? t('tracker.attachment.uploading') : t('tracker.report.submit')}
              <Kbd className="border-white/30 bg-white/15 text-white">{`${MOD_KEY}↵`}</Kbd>
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
