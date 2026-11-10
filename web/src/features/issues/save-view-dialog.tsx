import { useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { useViewMutations } from '../../api/queries'
import type { Filter, GroupBy, Sort, ViewLayout } from '../../api/tracker'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { ActionError, Button, Dialog, Field, TextInput } from '../../ui'
import { useReference } from './use-reference'

const NAME_MAX = 60

/** Saves the current filter, sort, layout and grouping as a new view; Admins may share it with everyone. */
export function SaveViewDialog({
  open,
  onOpenChange,
  filter,
  sort,
  layout,
  groupBy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  filter: Filter
  sort: Sort
  layout: ViewLayout
  groupBy: GroupBy
}) {
  const { t } = useText()
  const { me } = useReference()
  const navigate = useNavigate()
  const { create } = useViewMutations()
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [touched, setTouched] = useState(false)
  const nameError = touched && !name.trim() ? t('tracker.view.nameRequired') : Array.from(name.trim()).length > NAME_MAX ? t('tracker.form.tooLong', { max: NAME_MAX }) : undefined

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (!name.trim() || Array.from(name.trim()).length > NAME_MAX) return
    create.mutate(
      { name: name.trim(), filter, sort, layout, groupBy, shared: me.isAdmin && shared },
      {
        onSuccess: (view) => {
          onOpenChange(false)
          setName('')
          setShared(false)
          setTouched(false)
          void navigate({ to: paths.view(view.id) } as never)
        },
      }
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next)
      }}
      title={t('tracker.view.saveTitle')}
      description={t('tracker.view.saveLead')}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field id="view-name" label={t('tracker.view.name')} required error={nameError}>
          <TextInput id="view-name" autoFocus value={name} invalid={Boolean(nameError)} onChange={(event) => setName(event.target.value)} onBlur={() => setTouched(true)} maxLength={NAME_MAX * 2} />
        </Field>
        {me.isAdmin ? (
          <label className="flex items-start gap-2 text-sm text-stone-700">
            <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
            <span>
              {t('tracker.view.share')}
              <span className="block text-xs text-stone-500">{t('tracker.view.shareHint')}</span>
            </span>
          </label>
        ) : null}
        {create.error ? <ActionError error={create.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {t('tracker.common.cancel')}
          </Button>
          <Button type="submit" tone="primary" loading={create.isPending}>
            {t('tracker.common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
