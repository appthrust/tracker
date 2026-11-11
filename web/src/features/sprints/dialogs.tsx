// Sprint dialogs: create or edit (name, goal, one or two weeks — new
// sprints default to the workspace setting — and the start date; dates only
// while planned), close (how many issues are done and unfinished, where the
// unfinished ones go: the next planned sprint or the backlog) and delete (a
// planned sprint, Admin only; its issues return to the backlog).
import { useQuery } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { allIssuesQuery, sprintsQuery, useSprintMutations } from '../../api/queries'
import type { Sprint, SprintLength } from '../../api/tracker'
import { useText } from '../../i18n'
import { addDays, closeCounts, comingMonday, compareSprints, endsOnFor, SPRINT_GOAL_MAX_BYTES, SPRINT_LENGTHS, SPRINT_NAME_MAX } from '../../model/sprints'
import { ActionError, Button, ConfirmDialog, Dialog, Field, Notice, SelectInput, showToast, TextArea, TextInput } from '../../ui'
import { useReference } from '../issues/use-reference'
import { formatDay, unitValue, useToday } from './sprint-ui'

const bytes = (text: string) => new TextEncoder().encode(text).length

/** Create (no `sprint`) or edit a sprint. */
export function SprintFormDialog({ sprint, open, onOpenChange }: { sprint?: Sprint; open: boolean; onOpenChange: (open: boolean) => void }) {
  return open ? <SprintForm sprint={sprint} onOpenChange={onOpenChange} /> : null
}

function SprintForm({ sprint, onOpenChange }: { sprint?: Sprint; onOpenChange: (open: boolean) => void }) {
  const { t, locale } = useText()
  const { workspace } = useReference()
  const today = useToday()
  const sprints = useQuery(sprintsQuery).data ?? []
  const { create, update } = useSprintMutations()
  const mutation = sprint ? update : create
  const lengthId = useId()
  const [name, setName] = useState(sprint?.name ?? '')
  const [goal, setGoal] = useState(sprint?.goal ?? '')
  const [lengthWeeks, setLengthWeeks] = useState<SprintLength>(sprint?.lengthWeeks ?? workspace.sprintLengthWeeks)
  const [startsOn, setStartsOn] = useState(sprint?.startsOn ?? '')
  const [submitted, setSubmitted] = useState(false)
  const datesEditable = !sprint || sprint.state === 'planned'
  // The server's default start: the day after the last open sprint, else the coming Monday.
  const latest = sprints.filter((candidate) => candidate.state !== 'closed').sort((a, b) => b.endsOn.localeCompare(a.endsOn))[0]
  const defaultStart = latest ? addDays(latest.endsOn, 1) : comingMonday(today)
  const effectiveStart = startsOn || defaultStart
  const trimmed = name.trim()
  const nameError = sprint && !trimmed ? t('tracker.form.required') : Array.from(trimmed).length > SPRINT_NAME_MAX ? t('tracker.form.tooLong', { max: SPRINT_NAME_MAX }) : undefined
  const goalError = bytes(goal) > SPRINT_GOAL_MAX_BYTES ? t('tracker.form.tooLong', { max: SPRINT_GOAL_MAX_BYTES }) : undefined

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if (nameError || goalError || mutation.isPending) return
    const dates = datesEditable ? { lengthWeeks, ...(startsOn ? { startsOn } : {}) } : {}
    if (sprint) {
      update.mutate({ id: sprint.id, input: { name: trimmed, goal, ...dates } }, { onSuccess: () => onOpenChange(false) })
    } else {
      create.mutate(
        { ...(trimmed ? { name: trimmed } : {}), ...(goal.trim() ? { goal } : {}), ...dates },
        {
          onSuccess: (created) => {
            showToast({ tone: 'success', title: t('tracker.sprints.created', { name: created.name }) })
            onOpenChange(false)
          },
        }
      )
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!mutation.isPending) onOpenChange(next)
      }}
      title={sprint ? t('tracker.sprints.editTitle', { name: sprint.name }) : t('tracker.sprints.new')}
      description={sprint ? undefined : t('tracker.sprints.createLead')}
    >
      <form noValidate onSubmit={submit} className="space-y-4">
        <Field id="sprint-name" label={t('tracker.view.name')} hint={sprint ? undefined : t('tracker.sprints.nameHint')} error={submitted ? nameError : undefined}>
          <TextInput id="sprint-name" autoFocus value={name} invalid={submitted && Boolean(nameError)} placeholder={sprint ? undefined : t('tracker.sprints.namePlaceholder')} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field id="sprint-goal" label={t('tracker.sprints.goal')} hint={t('tracker.sprints.goalHint')} error={goalError}>
          <TextArea id="sprint-goal" rows={3} value={goal} invalid={Boolean(goalError)} onChange={(event) => setGoal(event.target.value)} />
        </Field>
        <fieldset disabled={!datesEditable} aria-describedby={datesEditable ? undefined : `${lengthId}-locked`}>
          <legend className="text-sm font-medium text-stone-800">{t('tracker.sprints.length')}</legend>
          <div className="mt-1.5 flex gap-2">
            {SPRINT_LENGTHS.map((weeks) => (
              <label
                key={weeks}
                className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 ${lengthWeeks === weeks ? 'border-accent-line bg-accent-soft text-accent-strong' : 'border-stone-300 text-stone-700 hover:bg-stone-50'}`}
              >
                <input type="radio" name={lengthId} className="accent-[var(--color-accent)]" checked={lengthWeeks === weeks} onChange={() => setLengthWeeks(weeks)} />
                {weeks === 1 ? t('tracker.sprints.oneWeek') : t('tracker.sprints.twoWeeks')}
                {!sprint && weeks === workspace.sprintLengthWeeks ? <span className="text-[11px] text-stone-500">{t('tracker.sprints.defaultLength')}</span> : null}
              </label>
            ))}
          </div>
        </fieldset>
        <Field
          id="sprint-starts"
          label={t('tracker.sprints.startsOn')}
          hint={t('tracker.sprints.endsOn', { start: formatDay(effectiveStart, locale, true), end: formatDay(endsOnFor(effectiveStart, lengthWeeks), locale, true) })}
        >
          <TextInput id="sprint-starts" type="date" value={startsOn} disabled={!datesEditable} placeholder={defaultStart} onChange={(event) => setStartsOn(event.target.value)} />
        </Field>
        {!datesEditable ? (
          <p id={`${lengthId}-locked`} className="text-xs text-stone-500">
            {t('tracker.sprints.datesLocked')}
          </p>
        ) : null}
        {mutation.error ? <ActionError error={mutation.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {t('tracker.common.cancel')}
          </Button>
          <Button type="submit" tone="primary" loading={mutation.isPending}>
            {sprint ? t('tracker.common.save') : t('tracker.sprints.createSubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** Close the active sprint: counts over its members and where the unfinished ones go (default: the next planned sprint). */
export function CloseSprintDialog({ sprint, open, onOpenChange }: { sprint: Sprint; open: boolean; onOpenChange: (open: boolean) => void }) {
  return open ? <CloseSprintForm sprint={sprint} onOpenChange={onOpenChange} /> : null
}

function CloseSprintForm({ sprint, onOpenChange }: { sprint: Sprint; onOpenChange: (open: boolean) => void }) {
  const { t } = useText()
  const { statusById } = useReference()
  const members = useQuery(allIssuesQuery({ sprint: [sprint.id] }, 'number'))
  const planned = (useQuery(sprintsQuery).data ?? []).filter((candidate) => candidate.state === 'planned').sort(compareSprints)
  const { close } = useSprintMutations()
  const [target, setTarget] = useState<string>(() => planned[0]?.id ?? '')
  const counts = closeCounts(members.data?.items ?? [], (statusId) => statusById.get(statusId)?.category)
  const destination = target ? planned.find((candidate) => candidate.id === target) : undefined
  const submit = () =>
    close.mutate(
      { id: sprint.id, moveIncompleteTo: target || null },
      {
        onSuccess: (closed) => {
          showToast({
            tone: 'success',
            title: t('tracker.sprints.closedToast', { name: closed.name }),
            detail: counts.unfinished > 0 ? (destination ? t('tracker.sprints.movedTo', { count: counts.unfinished, name: destination.name }) : t('tracker.sprints.movedToBacklog', { count: counts.unfinished })) : undefined,
          })
          onOpenChange(false)
        },
      }
    )
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!close.isPending) onOpenChange(next)
      }}
      title={t('tracker.sprints.closeTitle', { name: sprint.name })}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={close.isPending}>
            {t('tracker.common.cancel')}
          </Button>
          <Button tone="primary" onClick={submit} loading={close.isPending} disabled={members.isPending}>
            {t('tracker.sprints.closeSubmit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-line px-3 py-2.5">
            <dt className="text-xs text-stone-500">{t('tracker.chart.completed')}</dt>
            <dd className="mt-0.5 text-xl font-semibold text-stone-900 tabular-nums">{members.isPending ? '—' : t('tracker.list.count', { count: counts.done })}</dd>
            <dd className="text-xs text-stone-500">{t('tracker.sprints.closeVelocity', { value: unitValue(t, sprint.current.donePoints, 'points') })}</dd>
          </div>
          <div className="rounded-lg border border-line px-3 py-2.5">
            <dt className="text-xs text-stone-500">{t('tracker.sprints.closeUnfinishedLabel')}</dt>
            <dd className="mt-0.5 text-xl font-semibold text-stone-900 tabular-nums">{members.isPending ? '—' : t('tracker.list.count', { count: counts.unfinished })}</dd>
            <dd className="text-xs text-stone-500">{unitValue(t, sprint.current.scopePoints - sprint.current.donePoints, 'points')}</dd>
          </div>
        </dl>
        {members.isError ? <ActionError error={members.error} /> : null}
        {counts.unfinished > 0 || members.isPending ? (
          <Field id="close-target" label={t('tracker.sprints.closeMoveTo')} hint={t('tracker.sprints.closeMoveHint')}>
            <SelectInput id="close-target" value={target} onChange={(event) => setTarget(event.target.value)}>
              {planned.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
              <option value="">{t('tracker.sprint.backlog')}</option>
            </SelectInput>
          </Field>
        ) : (
          <Notice tone="success">{t('tracker.sprints.closeAllDone')}</Notice>
        )}
        <p className="text-xs text-stone-500">{t('tracker.sprints.closeCanceledStay')}</p>
        {close.error ? <ActionError error={close.error} /> : null}
      </div>
    </Dialog>
  )
}

export function DeleteSprintDialog({ sprint, open, onOpenChange, onDeleted }: { sprint: Sprint; open: boolean; onOpenChange: (open: boolean) => void; onDeleted?: () => void }) {
  const { t } = useText()
  const { remove } = useSprintMutations()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('tracker.sprints.deleteTitle', { name: sprint.name })}
      body={t('tracker.sprints.deleteBody')}
      confirmLabel={t('tracker.sprints.delete')}
      tone="danger"
      pending={remove.isPending}
      error={remove.error}
      onConfirm={() =>
        remove.mutate(sprint.id, {
          onSuccess: () => {
            onOpenChange(false)
            onDeleted?.()
          },
        })
      }
    />
  )
}
