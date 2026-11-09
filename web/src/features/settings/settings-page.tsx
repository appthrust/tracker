// `/settings/{workspace,statuses,labels}`. Team Admins edit; everyone else
// sees the same values read-only with a note on who can change them.
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useLabelMutations, useStatusMutations, useUpdateWorkspace } from '../../api/queries'
import type { Label, LabelColor, Status, StatusCategory } from '../../api/tracker'
import { useText } from '../../i18n'
import { CATEGORIES } from '../../model/issues'
import { paths } from '../../routes/paths'
import { ActionError, Button, cn, ConfirmDialog, Field, HrefLink, Notice, Section, TextInput, useDocumentTitle } from '../../ui'
import { useReference } from '../issues/use-reference'
import { COLOR_DOT, ColorDot, LABEL_COLORS, StatusIcon } from '../issues/visuals'

export type SettingsTab = 'workspace' | 'statuses' | 'labels'

const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/

export function SettingsPage({ tab }: { tab: SettingsTab }) {
  const { t } = useText()
  const { me } = useReference()
  const titles: Record<SettingsTab, string> = { workspace: t('tracker.settings.workspace'), statuses: t('tracker.settings.statuses'), labels: t('tracker.property.labels') }
  useDocumentTitle(titles[tab])
  const hrefs: Record<SettingsTab, string> = { workspace: paths.settingsWorkspace, statuses: paths.settingsStatuses, labels: paths.settingsLabels }
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
        <h1 className="text-xl font-semibold text-stone-900">{t('tracker.nav.settings')}</h1>
        <nav aria-label={t('tracker.nav.settings')} className="mt-4 flex gap-1 border-b border-line">
          {(Object.keys(titles) as SettingsTab[]).map((key) => (
            <HrefLink
              key={key}
              href={hrefs[key]}
              className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-stone-600 hover:text-stone-900"
              activeProps={{ className: 'border-accent font-medium text-stone-900' }}
            >
              {titles[key]}
            </HrefLink>
          ))}
        </nav>
        {!me.isAdmin ? (
          <Notice className="mt-6" title={t('tracker.settings.readOnlyTitle')}>
            {t('tracker.settings.readOnlyBody')}
          </Notice>
        ) : null}
        <div className="mt-6">{tab === 'workspace' ? <WorkspaceSettings /> : tab === 'statuses' ? <StatusSettings /> : <LabelSettings />}</div>
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
  const [saved, setSaved] = useState(false)
  const keyError = !KEY_PATTERN.test(key) ? t('tracker.settings.keyInvalid') : undefined
  const nameError = !name.trim() || name.trim().length > 100 ? t('tracker.settings.nameInvalid') : undefined
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (keyError || nameError) return
    setSaved(false)
    update.mutate({ key: key !== workspace.key ? key : undefined, name: name.trim() !== workspace.name ? name.trim() : undefined }, { onSuccess: () => setSaved(true) })
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
      {update.error ? <ActionError error={update.error} /> : null}
      {saved ? <Notice tone="success">{t('tracker.settings.saved')}</Notice> : null}
      {me.isAdmin ? (
        <Button type="submit" tone="primary" loading={update.isPending} disabled={key === workspace.key && name.trim() === workspace.name}>
          {t('tracker.common.save')}
        </Button>
      ) : null}
    </form>
  )
}

function ColorSelect({ value, onChange, label }: { value: string; onChange: (color: LabelColor) => void; label: string }) {
  const { t } = useText()
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {LABEL_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={t(`tracker.color.${color}`)}
          title={t(`tracker.color.${color}`)}
          onClick={() => onChange(color)}
          className={cn('flex size-6 items-center justify-center rounded-full', value === color ? 'ring-2 ring-stone-900 ring-offset-1' : 'hover:ring-1 hover:ring-stone-300')}
        >
          <span aria-hidden className={cn('size-3.5 rounded-full', COLOR_DOT[color])} />
        </button>
      ))}
    </div>
  )
}

function InlineName({ value, label, disabled, onSave }: { value: string; label: string; disabled: boolean; onSave: (name: string) => void }) {
  const [draft, setDraft] = useState(value)
  const commit = () => {
    const name = draft.trim()
    if (name && name !== value) onSave(name)
    else setDraft(value)
  }
  return (
    <input
      aria-label={label}
      value={draft}
      disabled={disabled}
      maxLength={40}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        if (event.key === 'Escape') setDraft(value)
      }}
      className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-[13px] text-stone-800 hover:border-stone-200 focus:border-accent focus:bg-white focus:outline-none disabled:hover:border-transparent"
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

function IconAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

function AddRow({ label, pending, onAdd }: { label: string; pending: boolean; onAdd: (name: string, color: LabelColor) => void }) {
  const { t } = useText()
  const [name, setName] = useState('')
  const [color, setColor] = useState<LabelColor>('gray')
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
        <TextInput aria-label={label} placeholder={label} value={name} onChange={(event) => setName(event.target.value)} maxLength={40} className="h-8 md:h-8" />
      </div>
      <ColorSelect value={color} label={t('tracker.settings.newColor')} onChange={setColor} />
      <Button type="submit" size="sm" icon={<Plus />} loading={pending} disabled={!name.trim()}>
        {t('tracker.relation.add')}
      </Button>
    </form>
  )
}
