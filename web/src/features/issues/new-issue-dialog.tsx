// "New issue" (C): project, title, Markdown description, type, status,
// priority, assignee and labels. The project starts as the list/board scope
// (or the one the opener passes). Choosing "bug" asks for the two required
// report fields; the full report form is `/report` (Shift+R). ⌘/Ctrl+Enter
// creates.
import { useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { useCreateIssue } from '../../api/queries'
import type { IssueType, Priority } from '../../api/tracker'
import { useText } from '../../i18n'
import { ISSUE_TYPES, PRIORITIES, reportProblems, TITLE_MAX, toReport, type ReportDraft } from '../../model/issues'
import { paths } from '../../routes/paths'
import { ActionError, Button, Dialog, Field, HrefLink, Kbd, SelectInput, TextArea, TextInput } from '../../ui'
import { EMPTY_REPORT, ReportFields } from '../report/report-fields'
import { MOD_KEY, setUi, uiStore, useUi } from '../ui-state'
import { ColorDot } from './visuals'
import { ProjectField } from './projects'
import { assigneeValue, usePeopleOptions } from './properties'
import { useReference } from './use-reference'

export function NewIssueDialog() {
  const defaults = useUi((state) => state.newIssue)
  // Remount per opening so every dialog starts empty with its own defaults.
  return defaults ? <NewIssueForm key={JSON.stringify(defaults)} statusId={defaults.statusId} projectId={defaults.projectId} /> : null
}

function NewIssueForm({ statusId: initialStatus, projectId: requestedProject }: { statusId?: string; projectId?: string | null }) {
  const { t } = useText()
  const navigate = useNavigate()
  const { statuses, labels, activeProjects } = useReference()
  const create = useCreateIssue()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<IssueType>('task')
  const [statusId, setStatusId] = useState(initialStatus ?? statuses.find((status) => status.category === 'backlog')?.id ?? '')
  const [priority, setPriority] = useState<Priority>('none')
  const [assignee, setAssignee] = useState('')
  const [labelIds, setLabelIds] = useState<string[]>([])
  const [report, setReport] = useState<ReportDraft>(EMPTY_REPORT)
  // The opener's choice, else the list/board scope; only an active project counts.
  const [projectId, setProjectId] = useState(() => {
    const initial = requestedProject !== undefined ? requestedProject : uiStore.state.scope
    return initial && activeProjects.some((project) => project.id === initial) ? initial : null
  })
  const [submitted, setSubmitted] = useState(false)
  const people = usePeopleOptions('', true, [])

  const problems = type === 'bug' ? reportProblems(title, report) : !title.trim() ? { title: 'required' as const } : Array.from(title.trim()).length > TITLE_MAX ? { title: 'tooLong' as const } : {}
  const { title: titleProblem, ...reportFieldProblems } = problems
  const close = () => setUi({ newIssue: null })

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    setSubmitted(true)
    if (Object.keys(problems).length > 0 || create.isPending) return
    const sub = assigneeValue(assignee || '__none')
    create.mutate(
      {
        title: title.trim(),
        description: description || undefined,
        type,
        priority,
        statusId: statusId || undefined,
        assigneeSub: sub ?? undefined,
        labelIds: labelIds.length > 0 ? labelIds : undefined,
        projectId: projectId ?? undefined,
        report: type === 'bug' ? toReport(report) : undefined,
      },
      {
        onSuccess: (issue) => {
          close()
          void navigate({ to: paths.issue(issue.identifier) } as never)
        },
      }
    )
  }

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => {
        if (!open && !create.isPending) close()
      }}
      title={t('tracker.nav.newIssue')}
    >
      <form
        noValidate
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        }}
        className="space-y-4"
      >
        <Field id="new-issue-project" label={t('tracker.project.label')} className="sm:w-1/2">
          <ProjectField id="new-issue-project" value={projectId} onChange={setProjectId} />
        </Field>
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
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="new-issue-type" label={t('tracker.property.type')}>
            <SelectInput id="new-issue-type" value={type} onChange={(event) => setType(event.target.value as IssueType)}>
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
              {people.options.map((option) => (
                <option key={option.value} value={option.value === '__none' ? '' : option.value}>
                  {option.label}
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
              <HrefLink href={paths.report} onClick={close} className="font-medium text-accent-strong underline">
                {t('tracker.nav.report')}
              </HrefLink>
            </p>
          </div>
        ) : null}
        {create.error ? <ActionError error={create.error} /> : null}
        <div className="flex items-center justify-end gap-2 border-t border-stone-100 pt-3">
          <Button onClick={close} disabled={create.isPending}>
            {t('tracker.common.cancel')}
          </Button>
          <Button type="submit" tone="primary" loading={create.isPending}>
            {t('tracker.newIssue.create')}
            <Kbd className="border-white/30 bg-white/15 text-white">{`${MOD_KEY}↵`}</Kbd>
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
