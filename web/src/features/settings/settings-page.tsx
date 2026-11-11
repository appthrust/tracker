// `/settings/{workspace,statuses,labels,projects,agents}`. Team Admins edit the
// workspace (key, name, default sprint length, the timezone sprint dates
// follow and how agent work is completed), statuses, labels and agents;
// everyone else sees them read-only with a note on who can change them.
// Projects are open to everyone (add, rename, describe, recolor); archiving
// and deleting stay with Admins.
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { useLabelMutations, useProjectMutations, useStatusMutations, useUpdateWorkspace } from '../../api/queries'
import type { Label, LabelColor, Project, SprintLength, Status, StatusCategory } from '../../api/tracker'
import { useText } from '../../i18n'
import { CATEGORIES, PROJECT_DESCRIPTION_MAX_BYTES, PROJECT_NAME_MAX } from '../../model/issues'
import { paths } from '../../routes/paths'
import { ActionError, Button, ConfirmDialog, Field, HrefLink, Notice, Section, SelectInput, TextInput, useDocumentTitle } from '../../ui'
import { AgentSettings, CompletionPolicy } from '../agents/agents-settings'
import { nextProjectColor, ProjectSwatch } from '../issues/projects'
import { useReference } from '../issues/use-reference'
import { ColorDot, ColorSelect, StatusIcon } from '../issues/visuals'

export type SettingsTab = 'workspace' | 'statuses' | 'labels' | 'projects' | 'agents'

const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/
const STATUS_LABEL_NAME_MAX = 40
/** IANA names for the timezone suggestions (the field accepts any name the browser knows). */
const TIME_ZONES: readonly string[] = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export function SettingsPage({ tab }: { tab: SettingsTab }) {
  const { t } = useText()
  const { me } = useReference()
  const titles: Record<SettingsTab, string> = {
    workspace: t('tracker.settings.workspace'),
    statuses: t('tracker.settings.statuses'),
    labels: t('tracker.property.labels'),
    projects: t('tracker.project.sidebar'),
    agents: t('tracker.settings.agents'),
  }
  useDocumentTitle(titles[tab])
  const hrefs: Record<SettingsTab, string> = { workspace: paths.settingsWorkspace, statuses: paths.settingsStatuses, labels: paths.settingsLabels, projects: paths.settingsProjects, agents: paths.settingsAgents }
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
        <h1 className="text-xl font-semibold text-stone-900">{t('tracker.nav.settings')}</h1>
        <nav aria-label={t('tracker.nav.settings')} className="mt-4 flex gap-1 overflow-x-auto border-b border-line">
          {(Object.keys(titles) as SettingsTab[]).map((key) => (
            <HrefLink
              key={key}
              href={hrefs[key]}
              className="-mb-px shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-stone-600 hover:text-stone-900"
              activeProps={{ className: 'border-accent font-medium text-stone-900' }}
            >
              {titles[key]}
            </HrefLink>
          ))}
        </nav>
        {!me.isAdmin && tab !== 'projects' && tab !== 'agents' ? (
          <Notice className="mt-6" title={t('tracker.settings.readOnlyTitle')}>
            {t('tracker.settings.readOnlyBody')}
          </Notice>
        ) : null}
        <div className="mt-6">
          {tab === 'workspace' ? (
            <div className="space-y-10">
              <WorkspaceSettings />
              <CompletionPolicy />
            </div>
          ) : tab === 'statuses' ? (
            <StatusSettings />
          ) : tab === 'labels' ? (
            <LabelSettings />
          ) : tab === 'agents' ? (
            <AgentSettings />
          ) : (
            <ProjectSettings />
          )}
        </div>
      </div>
    </div>
  )
}

function WorkspaceSettings() {
  const { t } = useText()
  const { workspace, me } = useReference()
  const update = useUpdateWorkspace()
  const [key, setKey] = useState(workspace.key)
  const [name, setName] = useState(workspace.name)
  const [sprintLength, setSprintLength] = useState<SprintLength>(workspace.sprintLengthWeeks)
  const [timezone, setTimezone] = useState(workspace.timezone)
  const [saved, setSaved] = useState(false)
  const keyError = !KEY_PATTERN.test(key) ? t('tracker.settings.keyInvalid') : undefined
  const nameError = !name.trim() || name.trim().length > 100 ? t('tracker.settings.nameInvalid') : undefined
  const timezoneError = !timezone.trim() || !isTimeZone(timezone.trim()) ? t('tracker.settings.timezoneInvalid') : undefined
  const unchanged = key === workspace.key && name.trim() === workspace.name && sprintLength === workspace.sprintLengthWeeks && timezone.trim() === workspace.timezone
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (keyError || nameError || timezoneError) return
    setSaved(false)
    update.mutate(
      {
        key: key !== workspace.key ? key : undefined,
        name: name.trim() !== workspace.name ? name.trim() : undefined,
        sprintLengthWeeks: sprintLength !== workspace.sprintLengthWeeks ? sprintLength : undefined,
        timezone: timezone.trim() !== workspace.timezone ? timezone.trim() : undefined,
      },
      { onSuccess: () => setSaved(true) }
    )
  }
  return (
    <form onSubmit={submit} className="max-w-md space-y-4" noValidate>
      <Field id="workspace-key" label={t('tracker.settings.key')} hint={t('tracker.settings.keyHint', { example: `${key || 'APT'}-12` })} error={keyError}>
        <TextInput id="workspace-key" value={key} disabled={!me.isAdmin} invalid={Boolean(keyError)} onChange={(event) => setKey(event.target.value.toUpperCase())} maxLength={6} className="font-mono uppercase" />
      </Field>
      <Field id="workspace-name" label={t('tracker.view.name')} error={nameError}>
        <TextInput id="workspace-name" value={name} disabled={!me.isAdmin} invalid={Boolean(nameError)} onChange={(event) => setName(event.target.value)} maxLength={100} />
      </Field>
      <p className="text-xs text-stone-500">{t('tracker.settings.issueCount', { count: workspace.issueCount })}</p>
      <h2 className="pt-2 text-base font-semibold text-stone-900">{t('tracker.nav.sprints')}</h2>
      <Field id="workspace-sprint-length" label={t('tracker.settings.sprintLength')} hint={t('tracker.settings.sprintLengthHint')}>
        <SelectInput id="workspace-sprint-length" value={sprintLength} disabled={!me.isAdmin} onChange={(event) => setSprintLength(Number(event.target.value) as SprintLength)}>
          <option value={1}>{t('tracker.sprints.oneWeek')}</option>
          <option value={2}>{t('tracker.sprints.twoWeeks')}</option>
        </SelectInput>
      </Field>
      <Field id="workspace-timezone" label={t('tracker.settings.timezone')} hint={t('tracker.settings.timezoneHint')} error={timezoneError}>
        <TextInput id="workspace-timezone" list="workspace-timezones" value={timezone} disabled={!me.isAdmin} invalid={Boolean(timezoneError)} onChange={(event) => setTimezone(event.target.value)} spellCheck={false} autoComplete="off" />
      </Field>
      <datalist id="workspace-timezones">
        {TIME_ZONES.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      {update.error ? <ActionError error={update.error} /> : null}
      {saved ? <Notice tone="success">{t('tracker.settings.saved')}</Notice> : null}
      {me.isAdmin ? (
        <Button type="submit" tone="primary" loading={update.isPending} disabled={unchanged}>
          {t('tracker.common.save')}
        </Button>
      ) : null}
    </form>
  )
}

function InlineName({
  value,
  label,
  disabled = false,
  onSave,
  maxLength = STATUS_LABEL_NAME_MAX,
  allowEmpty = false,
  placeholder,
  className,
}: {
  value: string
  label: string
  disabled?: boolean
  onSave: (name: string) => void
  maxLength?: number
  /** Descriptions may be cleared; names may not. */
  allowEmpty?: boolean
  placeholder?: string
  className?: string
}) {
  const [draft, setDraft] = useState(value)
  const commit = () => {
    const next = draft.trim()
    if ((next || allowEmpty) && next !== value) onSave(next)
    else setDraft(value)
  }
  return (
    <input
      aria-label={label}
      value={draft}
      disabled={disabled}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        if (event.key === 'Escape') setDraft(value)
      }}
      className={
        className ??
        'h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-[13px] text-stone-800 hover:border-stone-200 focus:border-accent focus:bg-white focus:outline-none disabled:hover:border-transparent'
      }
    />
  )
}

function StatusSettings() {
  const { t } = useText()
  const { statuses, me } = useReference()
  const { create, update, remove, reorder } = useStatusMutations()
  const [deleting, setDeleting] = useState<Status | null>(null)
  const error = create.error ?? update.error ?? reorder.error
  const move = (status: Status, step: -1 | 1) => {
    const ids = statuses.map((candidate) => candidate.id)
    const from = ids.indexOf(status.id)
    const to = from + step
    if (to < 0 || to >= ids.length || statuses[to]!.category !== status.category) return
    ;[ids[from], ids[to]] = [ids[to]!, ids[from]!]
    reorder.mutate(ids)
  }
  return (
    <div className="space-y-8">
      {error ? <ActionError error={error} /> : null}
      {CATEGORIES.map((category) => {
        const inCategory = statuses.filter((status) => status.category === category)
        return (
          <Section key={category} title={t(`tracker.category.${category}`)} lead={t(`tracker.category.${category}Hint`)}>
            <ul className="divide-y divide-stone-100 rounded-lg border border-line bg-white">
              {inCategory.map((status, index) => (
                <li key={status.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <StatusIcon status={status} />
                  <InlineName value={status.name} label={t('tracker.settings.statusName')} disabled={!me.isAdmin} onSave={(name) => update.mutate({ id: status.id, input: { name } })} />
                  {me.isAdmin ? <ColorSelect value={status.color} label={t('tracker.settings.color', { name: status.name })} onChange={(color) => update.mutate({ id: status.id, input: { color } })} /> : null}
                  {me.isAdmin ? (
                    <span className="flex items-center">
                      <IconAction label={t('tracker.settings.moveUp', { name: status.name })} disabled={index === 0} onClick={() => move(status, -1)}>
                        <ArrowUp />
                      </IconAction>
                      <IconAction label={t('tracker.settings.moveDown', { name: status.name })} disabled={index === inCategory.length - 1} onClick={() => move(status, 1)}>
                        <ArrowDown />
                      </IconAction>
                      <IconAction label={t('tracker.settings.deleteStatus', { name: status.name })} disabled={inCategory.length === 1} onClick={() => (remove.reset(), setDeleting(status))}>
                        <Trash2 />
                      </IconAction>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {me.isAdmin ? <AddRow label={t('tracker.settings.addStatus')} pending={create.isPending} onAdd={(name, color) => create.mutate({ name, category: category as StatusCategory, color })} /> : null}
          </Section>
        )
      })}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('tracker.settings.deleteStatusTitle', { name: deleting?.name ?? '' })}
        body={t('tracker.settings.deleteStatusBody')}
        confirmLabel={t('tracker.issue.delete')}
        tone="danger"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
      />
    </div>
  )
}

function LabelSettings() {
  const { t } = useText()
  const { labels, me } = useReference()
  const { create, update, remove } = useLabelMutations()
  const [deleting, setDeleting] = useState<Label | null>(null)
  const error = create.error ?? update.error
  return (
    <div className="space-y-4">
      {error ? <ActionError error={error} /> : null}
      {labels.length === 0 ? <p className="text-sm text-stone-500">{t('tracker.settings.noLabels')}</p> : null}
      <ul className="divide-y divide-stone-100 rounded-lg border border-line bg-white">
        {labels.map((label) => (
          <li key={label.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <ColorDot color={label.color} />
            <InlineName value={label.name} label={t('tracker.settings.labelName')} disabled={!me.isAdmin} onSave={(name) => update.mutate({ id: label.id, input: { name } })} />
            {me.isAdmin ? <ColorSelect value={label.color} label={t('tracker.settings.color', { name: label.name })} onChange={(color) => update.mutate({ id: label.id, input: { color } })} /> : null}
            {me.isAdmin ? (
              <IconAction label={t('tracker.settings.deleteLabel', { name: label.name })} onClick={() => (remove.reset(), setDeleting(label))}>
                <Trash2 />
              </IconAction>
            ) : null}
          </li>
        ))}
      </ul>
      {me.isAdmin ? <AddRow label={t('tracker.settings.addLabel')} pending={create.isPending} onAdd={(name, color) => create.mutate({ name, color })} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('tracker.settings.deleteLabelTitle', { name: deleting?.name ?? '' })}
        body={t('tracker.settings.deleteLabelBody')}
        confirmLabel={t('tracker.issue.delete')}
        tone="danger"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
      />
    </div>
  )
}

function IconAction({ label, onClick, disabled, title, describedBy, children }: { label: string; onClick: () => void; disabled?: boolean; title?: string; describedBy?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={describedBy}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

function AddRow({ label, pending, onAdd, maxLength = STATUS_LABEL_NAME_MAX, defaultColor = 'gray' }: { label: string; pending: boolean; onAdd: (name: string, color: LabelColor) => void; maxLength?: number; defaultColor?: LabelColor }) {
  const { t } = useText()
  const [name, setName] = useState('')
  const [color, setColor] = useState<LabelColor>(defaultColor)
  // Projects suggest the next unused color once the previous one is taken.
  useEffect(() => setColor(defaultColor), [defaultColor])
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!name.trim()) return
        onAdd(name.trim(), color)
        setName('')
      }}
    >
      <div className="w-56">
        <TextInput aria-label={label} placeholder={label} value={name} onChange={(event) => setName(event.target.value)} maxLength={maxLength} className="h-8 md:h-8" />
      </div>
      <ColorSelect value={color} label={t('tracker.settings.newColor')} onChange={setColor} />
      <Button type="submit" size="sm" icon={<Plus />} loading={pending} disabled={!name.trim()}>
        {t('tracker.relation.add')}
      </Button>
    </form>
  )
}

function ProjectSettings() {
  const { t } = useText()
  const { projects, me } = useReference()
  const { create, update, remove } = useProjectMutations()
  const [deleting, setDeleting] = useState<Project | null>(null)
  const error = create.error ?? update.error
  const active = projects.filter((project) => !project.archived)
  const archived = projects.filter((project) => project.archived)
  return (
    <div>
      <p className="text-sm text-stone-500">{t('tracker.settings.projectsLead')}</p>
      {!me.isAdmin ? (
        <Notice className="mt-4" title={t('tracker.settings.projectsAdminOnly')} />
      ) : null}
      {error ? <ActionError error={error} className="mt-4" /> : null}
      <Section title={t('tracker.settings.activeProjects')} lead={me.isAdmin ? t('tracker.settings.activeProjectsLead') : undefined} className="mt-6">
        {active.length === 0 ? (
          <p className="rounded-lg border border-dashed border-stone-300 bg-white px-4 py-6 text-center text-sm text-stone-500">{t('tracker.settings.noProjects')}</p>
        ) : (
          <ul className="divide-y divide-stone-100 rounded-lg border border-line bg-white">
            {active.map((project) => (
              <ProjectRow key={project.id} project={project} onUpdate={(input) => update.mutate({ id: project.id, input })} onDelete={() => (remove.reset(), setDeleting(project))} />
            ))}
          </ul>
        )}
        <AddRow label={t('tracker.settings.addProject')} maxLength={PROJECT_NAME_MAX} defaultColor={nextProjectColor(projects)} pending={create.isPending} onAdd={(name, color) => create.mutate({ name, color })} />
      </Section>
      {archived.length > 0 ? (
        <Section title={t('tracker.project.archived')} lead={t('tracker.settings.archivedProjectsLead')}>
          <ul className="divide-y divide-stone-100 rounded-lg border border-line bg-stone-50/60">
            {archived.map((project) => (
              <ProjectRow key={project.id} project={project} onUpdate={(input) => update.mutate({ id: project.id, input })} onDelete={() => (remove.reset(), setDeleting(project))} />
            ))}
          </ul>
        </Section>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('tracker.settings.deleteProjectTitle', { name: deleting?.name ?? '' })}
        body={t('tracker.settings.deleteProjectBody')}
        confirmLabel={t('tracker.issue.delete')}
        tone="danger"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
      />
    </div>
  )
}

/** Name, counts, color and description for anyone; archive/restore and delete for Admins (delete only while no issue uses it). */
function ProjectRow({ project, onUpdate, onDelete }: { project: Project; onUpdate: (input: { name?: string; description?: string; color?: LabelColor; archived?: boolean }) => void; onDelete: () => void }) {
  const { t } = useText()
  const { me } = useReference()
  const blockedId = useId()
  const inUse = project.issueCount > 0
  const blockedText = t('tracker.settings.deleteProjectBlocked', { name: project.name, count: project.issueCount })
  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <ProjectSwatch color={project.color} className="size-3" />
        <InlineName value={project.name} label={t('tracker.settings.projectName')} maxLength={PROJECT_NAME_MAX} onSave={(name) => onUpdate({ name })} />
        <span className="text-xs text-stone-500 tabular-nums">{t('tracker.settings.projectCounts', { open: project.openIssueCount, total: project.issueCount })}</span>
        {me.isAdmin ? (
          <span className="flex items-center">
            <Button
              size="sm"
              tone="ghost"
              icon={project.archived ? <ArchiveRestore /> : <Archive />}
              aria-label={project.archived ? t('tracker.settings.unarchiveProjectLabel', { name: project.name }) : t('tracker.settings.archiveProjectLabel', { name: project.name })}
              onClick={() => onUpdate({ archived: !project.archived })}
            >
              {project.archived ? t('tracker.settings.unarchiveProject') : t('tracker.settings.archiveProject')}
            </Button>
            <IconAction
              label={t('tracker.settings.deleteProject', { name: project.name })}
              title={inUse ? blockedText : undefined}
              disabled={inUse}
              describedBy={inUse ? blockedId : undefined}
              onClick={onDelete}
            >
              <Trash2 />
            </IconAction>
            {inUse ? (
              <span id={blockedId} className="sr-only">
                {blockedText}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 ml-5 flex flex-wrap items-center gap-2">
        <InlineName
          value={project.description}
          label={t('tracker.settings.projectDescription', { name: project.name })}
          placeholder={t('tracker.settings.projectDescriptionPlaceholder')}
          maxLength={PROJECT_DESCRIPTION_MAX_BYTES}
          allowEmpty
          onSave={(description) => onUpdate({ description })}
          className="h-7 min-w-48 flex-1 rounded-md border border-transparent bg-transparent px-2 text-xs text-stone-600 placeholder:text-stone-400 hover:border-stone-200 focus:border-accent focus:bg-white focus:outline-none"
        />
        <ColorSelect value={project.color} label={t('tracker.settings.color', { name: project.name })} onChange={(color) => onUpdate({ color })} />
      </div>
    </li>
  )
}
