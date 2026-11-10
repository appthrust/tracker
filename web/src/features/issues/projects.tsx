// Project choice everywhere an issue gets one (new issue, bug report, detail
// sidebar, row chips) and the list/board scope switcher. Both are searchable
// pickers over the active projects with "No project" and an inline
// "Create project…": with words typed in the search it creates that project
// at once, with an empty search it opens the create dialog. A new project is
// picked (or scoped to) as soon as it exists.
import { ChevronsUpDown, CircleDashed, Layers, Plus } from 'lucide-react'
import { useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode, type Ref } from 'react'
import { useProjectMutations } from '../../api/queries'
import type { LabelColor, Project } from '../../api/tracker'
import { useText, type Translate } from '../../i18n'
import { PROJECT_DESCRIPTION_MAX_BYTES, PROJECT_NAME_MAX } from '../../model/issues'
import { ActionError, Button, cn, Dialog, errorDetail, errorMessageId, Field, Picker, showToast, TextArea, TextInput, type PickerOption } from '../../ui'
import { useReference } from './use-reference'
import { COLOR_DOT, ColorSelect, LABEL_COLORS } from './visuals'

/** Picker values that are not project ids. `none` doubles as the Filter value for "no project". */
export const NO_PROJECT = 'none'
const ALL_PROJECTS = '__all'
const CREATE_PROJECT = '__create'

/** The first palette color no active project uses yet (gray when all are taken), so new projects tell apart. */
export function nextProjectColor(projects: readonly Project[]): LabelColor {
  const used = new Set(projects.filter((project) => !project.archived).map((project) => project.color))
  return LABEL_COLORS.find((color) => color !== 'gray' && !used.has(color)) ?? 'gray'
}

/** Projects use square swatches; labels use round dots. */
export function ProjectSwatch({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2.5 shrink-0 rounded-[3px]', COLOR_DOT[(color in COLOR_DOT ? color : 'gray') as LabelColor], className)} />
}

/** Color swatch and name, as on list rows and board cards. */
export function ProjectPill({ project }: { project: Project }) {
  return (
    <span className={cn('inline-flex h-5 max-w-36 shrink-0 items-center gap-1 rounded-md border border-line bg-white px-1.5 text-[11px] font-medium text-stone-600', project.archived && 'text-stone-400')}>
      <ProjectSwatch color={project.color} className="size-2" />
      <span className="truncate">{project.name}</span>
    </span>
  )
}

/**
 * "No project" (when `none`), the active projects plus the `current` archived one, and the create entry, filtered by `query`.
 * Issue pickers list "No project" first (the usual reset); the scope switcher lists it after the projects.
 */
function projectOptions(
  t: Translate,
  projects: readonly Project[],
  query: string,
  { none, noneLast = false, current, counts = false }: { none: boolean; noneLast?: boolean; current: string | null; counts?: boolean }
): PickerOption[] {
  const typed = query.trim()
  const needle = typed.toLowerCase()
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle)
  const noneOptions: PickerOption[] = none && matches(t('tracker.project.none')) ? [{ value: NO_PROJECT, label: t('tracker.project.none'), icon: <CircleDashed className="text-stone-400" /> }] : []
  const projectItems: PickerOption[] = projects
    .filter((project) => (!project.archived || project.id === current) && matches(project.name))
    .map((project) => ({
      value: project.id,
      label: project.name,
      icon: <ProjectSwatch color={project.color} />,
      detail: project.archived ? t('tracker.project.archived') : counts ? String(project.openIssueCount) : undefined,
    }))
  const createOptions: PickerOption[] =
    !typed || !projects.some((project) => project.name === typed)
      ? [{ value: CREATE_PROJECT, label: typed ? t('tracker.project.createNamed', { name: typed }) : t('tracker.project.create'), icon: <Plus className="text-stone-500" /> }]
      : []
  return noneLast ? [...projectItems, ...noneOptions, ...createOptions] : [...noneOptions, ...projectItems, ...createOptions]
}

/** Creates a project named from the search words, else opens the dialog; `onCreated` receives the new project. */
function useProjectCreation(onCreated: (project: Project) => void) {
  const { t } = useText()
  const { projects } = useReference()
  const { create } = useProjectMutations()
  const [dialog, setDialog] = useState(false)
  const start = (typed: string) => {
    const name = typed.trim()
    if (!name) return setDialog(true)
    // The promise settles even if the picker's owner (a list row) unmounts meanwhile; per-call `mutate` callbacks would not.
    void create.mutateAsync({ name, color: nextProjectColor(projects) }).then(
      (project) => {
        showToast({ tone: 'success', title: t('tracker.project.created', { name: project.name }) })
        onCreated(project)
      },
      (error: unknown) => {
        const known = errorMessageId(error)
        showToast({ tone: 'error', title: t('tracker.project.createFailed'), detail: [known ? t(known) : undefined, errorDetail(error)].filter(Boolean).join(' ') || undefined })
      }
    )
  }
  const element = <CreateProjectDialog open={dialog} onOpenChange={setDialog} onCreated={onCreated} />
  return { start, element }
}

/**
 * Single project choice for an issue: `value` null = no project. `children` is
 * the trigger (one focusable element that forwards Radix's props).
 */
export function ProjectPicker({
  value,
  onChange,
  children,
  align = 'start',
}: {
  value: string | null
  onChange: (projectId: string | null) => void
  children: ReactNode
  align?: 'start' | 'end'
}) {
  const { t } = useText()
  const { projects } = useReference()
  const [query, setQuery] = useState('')
  const creation = useProjectCreation((project) => onChange(project.id))
  return (
    <>
      <Picker
        label={t('tracker.project.choose')}
        options={projectOptions(t, projects, query, { none: true, current: value })}
        selected={[value ?? NO_PROJECT]}
        onQueryChange={setQuery}
        onPick={(picked) => {
          if (picked === CREATE_PROJECT) return creation.start(query)
          onChange(picked === NO_PROJECT ? null : picked)
        }}
        empty={t('tracker.project.noMatch')}
        align={align}
      >
        {children}
      </Picker>
      {creation.element}
    </>
  )
}

/** Form control look for a ProjectPicker trigger (new issue dialog, bug report). */
export function ProjectField({ id, value, onChange }: { id: string; value: string | null; onChange: (projectId: string | null) => void }) {
  const { t } = useText()
  const { projectById } = useReference()
  const project = value ? projectById.get(value) : undefined
  return (
    <ProjectPicker value={value} onChange={onChange}>
      <FieldTrigger id={id}>
        {project ? <ProjectSwatch color={project.color} /> : <CircleDashed aria-hidden className="size-3.5 shrink-0 text-stone-400" />}
        <span className={cn('min-w-0 flex-1 truncate text-left', !project && 'text-stone-500')}>{project?.name ?? t('tracker.project.none')}</span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-stone-400" />
      </FieldTrigger>
    </ProjectPicker>
  )
}

function FieldTrigger({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-10 w-full items-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-900 shadow-xs transition-colors hover:border-stone-400 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent data-[state=open]:border-accent md:h-9',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * The list/board scope: all projects, one project, or issues without one.
 * `value` is the scoped project id or `none`, null for all; `many` > 1 when
 * the filter names several projects (shown as "N projects"). With no
 * projects yet it offers "All projects" and "Create project…" only.
 */
export function ProjectScopeSwitcher({ value, many, onChange }: { value: string | null; many: number; onChange: (scope: string | null) => void }) {
  const { t } = useText()
  const { projects, activeProjects, projectById } = useReference()
  const [query, setQuery] = useState('')
  const creation = useProjectCreation((project) => onChange(project.id))
  const project = value && value !== NO_PROJECT ? projectById.get(value) : undefined
  const label = many > 1 ? t('tracker.project.scopeMany', { count: many }) : value === null ? t('tracker.project.all') : value === NO_PROJECT ? t('tracker.project.none') : (project?.name ?? t('tracker.project.unknown'))
  const allMatches = !query.trim() || t('tracker.project.all').toLowerCase().includes(query.trim().toLowerCase())
  const options: PickerOption[] = [
    ...(allMatches ? [{ value: ALL_PROJECTS, label: t('tracker.project.all'), icon: <Layers className="text-stone-400" /> }] : []),
    ...projectOptions(t, projects, query, { none: activeProjects.length > 0 || value === NO_PROJECT, noneLast: true, current: value, counts: true }),
  ]
  return (
    <>
      <Picker
        label={t('tracker.project.scope')}
        options={options}
        selected={many > 1 ? [] : [value ?? ALL_PROJECTS]}
        onQueryChange={setQuery}
        onPick={(picked) => {
          if (picked === CREATE_PROJECT) return creation.start(query)
          onChange(picked === ALL_PROJECTS ? null : picked)
        }}
        empty={t('tracker.project.noMatch')}
      >
        <button
          type="button"
          aria-label={`${t('tracker.project.scope')}: ${label}`}
          className={cn(
            'inline-flex h-7 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-md border px-2 text-[13px] font-medium shadow-xs transition-colors data-[state=open]:bg-stone-100',
            value === null && many <= 1 ? 'border-line bg-white text-stone-700 hover:bg-stone-50' : 'border-accent-line bg-accent-soft text-accent-strong hover:bg-accent-soft'
          )}
        >
          {project ? (
            <ProjectSwatch color={project.color} />
          ) : value === NO_PROJECT ? (
            <CircleDashed aria-hidden className="size-3.5 shrink-0 text-stone-400" />
          ) : (
            <Layers aria-hidden className="size-3.5 shrink-0 text-stone-400" />
          )}
          <span className="truncate">{label}</span>
          <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 opacity-60" />
        </button>
      </Picker>
      {creation.element}
    </>
  )
}

/** Name, color and optional description; the new project goes to `onCreated` (which picks or scopes to it). */
export function CreateProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated?: (project: Project) => void }) {
  return open ? <CreateProjectForm onOpenChange={onOpenChange} onCreated={onCreated} /> : null
}

function CreateProjectForm({ onOpenChange, onCreated }: { onOpenChange: (open: boolean) => void; onCreated?: (project: Project) => void }) {
  const { t } = useText()
  const { projects } = useReference()
  const { create } = useProjectMutations()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<LabelColor>(() => nextProjectColor(projects))
  const [submitted, setSubmitted] = useState(false)
  const trimmed = name.trim()
  const nameError = !trimmed ? t('tracker.form.required') : Array.from(trimmed).length > PROJECT_NAME_MAX ? t('tracker.form.tooLong', { max: PROJECT_NAME_MAX }) : undefined
  const descriptionError = new TextEncoder().encode(description).length > PROJECT_DESCRIPTION_MAX_BYTES ? t('tracker.form.tooLong', { max: PROJECT_DESCRIPTION_MAX_BYTES }) : undefined
  const submit = (event: FormEvent) => {
    event.preventDefault()
    // The dialog can sit inside another form (the new-issue dialog); its submit must stay here.
    event.stopPropagation()
    setSubmitted(true)
    if (nameError || descriptionError || create.isPending) return
    create.mutate(
      { name: trimmed, color, description: description.trim() || undefined },
      {
        onSuccess: (project) => {
          onOpenChange(false)
          onCreated?.(project)
        },
      }
    )
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next)
      }}
      title={t('tracker.project.createTitle')}
      description={t('tracker.project.createLead')}
    >
      {/* Portaled, but React events still bubble to an enclosing form (new issue): its ⌘↵ must not fire from here. */}
      <form noValidate onSubmit={submit} onKeyDown={(event) => event.stopPropagation()} className="space-y-4">
        <Field id="new-project-name" label={t('tracker.view.name')} required error={submitted ? nameError : undefined}>
          <TextInput id="new-project-name" autoFocus value={name} invalid={submitted && Boolean(nameError)} onChange={(event) => setName(event.target.value)} maxLength={PROJECT_NAME_MAX * 2} />
        </Field>
        <div>
          <p className="text-sm font-medium text-stone-800">{t('tracker.settings.newColor')}</p>
          <div className="mt-1.5">
            <ColorSelect value={color} onChange={setColor} label={t('tracker.settings.newColor')} />
          </div>
        </div>
        <Field id="new-project-description" label={t('tracker.project.descriptionLabel')} error={descriptionError}>
          <TextArea id="new-project-description" rows={3} value={description} invalid={Boolean(descriptionError)} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        {create.error ? <ActionError error={create.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {t('tracker.common.cancel')}
          </Button>
          <Button type="submit" tone="primary" loading={create.isPending}>
            {t('tracker.project.createSubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
