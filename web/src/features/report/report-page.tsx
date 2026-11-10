// `/report`: the bug report form. Creates a `type=bug` issue with the
// AppThrust report fields (and a project, starting as the list/board scope),
// uploads the pasted/dropped screenshots to it, and lands on the new issue.
// `?version=` (from a link on a release page) prefills the version.
import { useNavigate } from '@tanstack/react-router'
import { Bug, ImagePlus, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react'
import { trackerApi, type Priority } from '../../api/tracker'
import { useCreateIssue } from '../../api/queries'
import { useText } from '../../i18n'
import { ATTACHMENT_TYPES, ATTACHMENTS_PER_ISSUE, attachmentProblem, PRIORITIES, reportProblems, TITLE_MAX, toReport, type ReportDraft } from '../../model/issues'
import { paths } from '../../routes/paths'
import { ActionError, Button, cn, Field, HrefLink, Kbd, Notice, SelectInput, TextInput, useDocumentTitle } from '../../ui'
import { problemText, transferFiles } from '../issues/attachments'
import { ProjectField } from '../issues/projects'
import { useReference } from '../issues/use-reference'
import { MOD_KEY, uiStore } from '../ui-state'
import { EMPTY_REPORT, ReportFields, type ReportProblems } from './report-fields'

type Shot = { file: File; preview: string | null }

export function ReportPage({ version }: { version?: string }) {
  const { t } = useText()
  useDocumentTitle(t('tracker.nav.report'))
  const navigate = useNavigate()
  const create = useCreateIssue()
  const id = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const { activeProjects } = useReference()
  const [projectId, setProjectId] = useState<string | null>(() => activeProjects.find((project) => project.id === uiStore.state.scope)?.id ?? null)
  const [draft, setDraft] = useState<ReportDraft>({ ...EMPTY_REPORT, version: version ?? '' })
  const [shots, setShots] = useState<Shot[]>([])
  const [shotError, setShotError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [uploadFailure, setUploadFailure] = useState<{ identifier: string; failed: string[] } | null>(null)
  const [uploading, setUploading] = useState(false)

  const all = reportProblems(title, draft)
  const { title: titleProblem, ...fieldProblems } = all
  const shown: ReportProblems = submitted ? fieldProblems : {}

  // Object URLs live as long as their preview: revoked on removal and when the page goes away.
  const shotsRef = useRef(shots)
  shotsRef.current = shots
  useEffect(() => () => shotsRef.current.forEach((shot) => shot.preview && URL.revokeObjectURL(shot.preview)), [])

  const addFiles = (files: File[]) => {
    setShotError(null)
    const accepted: Shot[] = []
    for (const file of files) {
      const problem = attachmentProblem(file, shots.length + accepted.length)
      if (problem) {
        setShotError(problemText(t, problem, file))
        continue
      }
      accepted.push({ file, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null })
    }
    if (accepted.length > 0) setShots((current) => [...current, ...accepted])
  }
  const removeShot = (index: number) => {
    const preview = shots[index]?.preview
    if (preview) URL.revokeObjectURL(preview)
    setShots((current) => current.filter((_, at) => at !== index))
  }
  const onPaste = (event: ClipboardEvent) => {
    const files = transferFiles(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }
  const onDrop = (event: DragEvent) => {
    const files = transferFiles(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    setSubmitted(true)
    if (Object.keys(all).length > 0 || create.isPending || uploading) return
    const issue = await create.mutateAsync({ title: title.trim(), type: 'bug', priority, report: toReport(draft), projectId: projectId ?? undefined }).catch(() => undefined)
    if (!issue) return
    setUploading(true)
    const failed: string[] = []
    for (const shot of shots) {
      try {
        await trackerApi.issues.attach(issue.id, shot.file)
      } catch {
        failed.push(shot.file.name)
      }
    }
    setUploading(false)
    if (failed.length > 0) return setUploadFailure({ identifier: issue.identifier, failed })
    void navigate({ to: paths.issue(issue.identifier) } as never)
  }

  if (uploadFailure) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <Notice
          tone="warning"
          title={t('tracker.report.uploadFailedTitle', { identifier: uploadFailure.identifier })}
          actions={
            <HrefLink href={paths.issue(uploadFailure.identifier)} className="text-sm font-medium underline">
              {t('tracker.palette.openIssue', { identifier: uploadFailure.identifier })}
            </HrefLink>
          }
        >
          {t('tracker.report.uploadFailedBody', { files: uploadFailure.failed.join(', ') })}
        </Notice>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto" onPaste={onPaste}>
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
                {shots.length} / {ATTACHMENTS_PER_ISSUE}
              </span>
            </div>
            <div
              role="group"
              aria-labelledby={`${id}-shots`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={onDrop}
              className={cn('mt-1.5 rounded-lg border border-dashed border-stone-300 bg-white p-3', shots.length === 0 && 'py-6')}
            >
              {shots.length > 0 ? (
                <ul className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {shots.map((shot, index) => (
                    <li key={`${shot.file.name}-${index}`} className="group relative overflow-hidden rounded-md border border-line">
                      {shot.preview ? (
                        <img src={shot.preview} alt={shot.file.name} className="aspect-video w-full bg-stone-50 object-contain" />
                      ) : (
                        <span className="flex aspect-video items-center justify-center bg-stone-50 text-xs text-stone-500">{shot.file.type}</span>
                      )}
                      <span className="block truncate border-t border-line px-2 py-1 text-[11px] text-stone-600">{shot.file.name}</span>
                      <button
                        type="button"
                        aria-label={t('tracker.attachment.delete', { name: shot.file.name })}
                        onClick={() => removeShot(index)}
                        className="absolute top-1 right-1 flex size-6 items-center justify-center rounded bg-white/90 text-stone-500 shadow-sm hover:text-bad-ink"
                      >
                        <X aria-hidden className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-col items-center gap-2 text-center text-xs text-stone-500 sm:flex-row sm:justify-center">
                <span>{t('tracker.report.screenshotsHint', { mod: MOD_KEY })}</span>
                <Button size="sm" icon={<ImagePlus />} onClick={() => fileInput.current?.click()} disabled={shots.length >= ATTACHMENTS_PER_ISSUE}>
                  {t('tracker.report.chooseFile')}
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept={ATTACHMENT_TYPES.join(',')}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(event) => {
                    addFiles([...(event.target.files ?? [])])
                    event.target.value = ''
                  }}
                />
              </div>
            </div>
            {shotError ? (
              <p role="alert" className="mt-1.5 text-xs text-bad-ink">
                {shotError}
              </p>
            ) : null}
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
            <Button type="submit" tone="primary" loading={create.isPending || uploading}>
              {uploading ? t('tracker.attachment.uploading') : t('tracker.report.submit')}
              <Kbd className="border-white/30 bg-white/15 text-white">{`${MOD_KEY}↵`}</Kbd>
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
