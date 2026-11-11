// `/settings/agents` and the workspace's completion policy. Everyone sees
// the agents (name, @handle, responsible person, what to delegate, last
// seen, work in progress, open requests and the median time their requests
// waited for a person, from the answered requests); Admins register (the
// handle is fixed from then on), edit, disable — with a confirmation that
// says the agent's work in progress is stopped — and copy the exact `apth`
// command that mints a key. The key is shown once by the platform, never by
// Tracker. Runs by outcome are not shown: no route lists runs across issues.
import { useQuery } from '@tanstack/react-query'
import { Bot, Check, Copy, KeyRound, Pencil, Plus, Power, PowerOff } from 'lucide-react'
import { useId, useMemo, useState, type FormEvent } from 'react'
import { peopleQuery, requestsQuery, useAgentMutations, useUpdateWorkspace } from '../../api/queries'
import { isTrackerError, type Agent, type AgentCompletion, type Person } from '../../api/tracker'
import { useText } from '../../i18n'
import { accessKeyCommand, AGENT_COMPLETIONS, AGENT_DESCRIPTION_MAX_BYTES, AGENT_HANDLE_PATTERN, AGENT_NAME_MAX, medianWaitMs } from '../../model/agents'
import { ActionError, Avatar, Button, cn, ConfirmDialog, Dialog, Field, formatDateTime, formatDuration, formatRelative, Notice, Section, SelectInput, showToast, TextArea, TextInput } from '../../ui'
import { useReference } from '../issues/use-reference'
import { AgentTag } from './actor'

export function AgentSettings() {
  const { t } = useText()
  const { agents, me } = useReference()
  const { update } = useAgentMutations()
  const answered = useQuery(requestsQuery({ state: 'answered' }))
  const [editing, setEditing] = useState<Agent | 'new' | null>(null)
  const [disabling, setDisabling] = useState<Agent | null>(null)
  const [keyFor, setKeyFor] = useState<string | null>(null)
  const waits = useMemo(() => {
    const byAgent = new Map<string, number | null>()
    for (const agent of agents) byAgent.set(agent.id, medianWaitMs((answered.data ?? []).filter((request) => request.from.sub === `agent:${agent.id}`)))
    return byAgent
  }, [agents, answered.data])
  const active = agents.filter((agent) => !agent.disabled)
  const disabled = agents.filter((agent) => agent.disabled)
  const row = (agent: Agent) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      wait={waits.get(agent.id) ?? null}
      showKey={keyFor === agent.id}
      onToggleKey={() => setKeyFor((current) => (current === agent.id ? null : agent.id))}
      onEdit={() => setEditing(agent)}
      onDisable={() => (update.reset(), setDisabling(agent))}
      onEnable={() => update.mutate({ id: agent.id, input: { disabled: false } })}
    />
  )
  return (
    <div>
      <p className="max-w-prose text-sm text-stone-500">{t('tracker.agents.lead')}</p>
      {!me.isAdmin ? <Notice className="mt-4" title={t('tracker.agents.adminOnly')} /> : null}
      {update.error && !disabling ? <ActionError error={update.error} className="mt-4" /> : null}
      <Section
        title={t('tracker.settings.agents')}
        className="mt-6"
        actions={
          me.isAdmin ? (
            <Button tone="primary" size="sm" icon={<Plus />} onClick={() => setEditing('new')}>
              {t('tracker.agents.register')}
            </Button>
          ) : undefined
        }
      >
        {active.length === 0 ? (
          <p className="rounded-lg border border-dashed border-stone-300 bg-white px-4 py-6 text-center text-sm text-stone-500">{t('tracker.agents.empty')}</p>
        ) : (
          <ul className="divide-y divide-stone-100 rounded-lg border border-line bg-white">{active.map(row)}</ul>
        )}
      </Section>
      {disabled.length > 0 ? (
        <Section title={t('tracker.agent.disabled')}>
          <ul className="divide-y divide-stone-100 rounded-lg border border-line bg-stone-50/60">{disabled.map(row)}</ul>
        </Section>
      ) : null}
      {editing ? <AgentDialog agent={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onCreated={(agent) => setKeyFor(agent.id)} /> : null}
      <ConfirmDialog
        open={disabling !== null}
        onOpenChange={(open) => !open && setDisabling(null)}
        title={t('tracker.agents.disableTitle', { name: disabling?.name ?? '' })}
        body={t('tracker.agents.disableBody', { name: disabling?.name ?? '', count: disabling?.activeRuns ?? 0 })}
        confirmLabel={t('tracker.agents.disable')}
        tone="danger"
        pending={update.isPending}
        error={update.error}
        onConfirm={() => disabling && update.mutate({ id: disabling.id, input: { disabled: true } }, { onSuccess: () => setDisabling(null) })}
      />
    </div>
  )
}

function AgentRow({ agent, wait, showKey, onToggleKey, onEdit, onDisable, onEnable }: { agent: Agent; wait: number | null; showKey: boolean; onToggleKey: () => void; onEdit: () => void; onDisable: () => void; onEnable: () => void }) {
  const { t, locale } = useText()
  const { me } = useReference()
  const keyId = useId()
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <Avatar person={{ name: agent.name, kind: 'agent' }} size="md" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-stone-900">{agent.name}</span>
            <span className="font-mono text-xs text-stone-500">@{agent.handle}</span>
            <AgentTag disabled={agent.disabled} />
          </p>
          <p className="mt-0.5 text-xs text-stone-600">{t('tracker.agent.ownedBy', { name: agent.owner.name })}</p>
          {agent.description ? <p className="mt-1.5 max-w-prose text-[13px] leading-relaxed text-stone-700">{agent.description}</p> : null}
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500">
            {agent.lastSeenAt ? (
              <time dateTime={agent.lastSeenAt} title={formatDateTime(agent.lastSeenAt, locale)}>
                {t('tracker.agents.lastSeen', { time: formatRelative(agent.lastSeenAt, locale) })}
              </time>
            ) : (
              <span>{t('tracker.agents.neverSeen')}</span>
            )}
            <span className={cn(agent.activeRuns > 0 && 'font-medium text-accent-strong')}>{t('tracker.agents.activeRuns', { count: agent.activeRuns })}</span>
            <span className={cn(agent.openRequests > 0 && 'font-medium text-busy-ink')}>{t('tracker.run.openRequests', { count: agent.openRequests })}</span>
            <span>{wait === null ? t('tracker.agents.noWait') : t('tracker.agents.medianWait', { time: formatDuration(wait, locale) })}</span>
          </p>
        </div>
        {me.isAdmin ? (
          <div className="flex flex-wrap items-center gap-1">
            {!agent.disabled ? (
              <Button size="sm" tone="ghost" icon={<KeyRound />} aria-expanded={showKey} aria-controls={keyId} onClick={onToggleKey}>
                {t('tracker.agents.keyTitle')}
              </Button>
            ) : null}
            <Button size="sm" tone="ghost" icon={<Pencil />} aria-label={t('tracker.agents.editLabel', { name: agent.name })} onClick={onEdit}>
              {t('tracker.report.edit')}
            </Button>
            {agent.disabled ? (
              <Button size="sm" tone="ghost" icon={<Power />} aria-label={t('tracker.agents.enableLabel', { name: agent.name })} onClick={onEnable}>
                {t('tracker.agents.enable')}
              </Button>
            ) : (
              <Button size="sm" tone="ghost" icon={<PowerOff />} aria-label={t('tracker.agents.disableLabel', { name: agent.name })} onClick={onDisable} className="text-bad-ink hover:bg-bad-soft hover:text-bad-ink">
                {t('tracker.agents.disable')}
              </Button>
            )}
          </div>
        ) : null}
      </div>
      {showKey ? <KeyCommand id={keyId} agent={agent} /> : null}
    </li>
  )
}

/** The exact `apth` command and a copy button; the key itself never passes through Tracker. */
function KeyCommand({ id, agent }: { id: string; agent: Agent }) {
  const { t } = useText()
  const [copied, setCopied] = useState(false)
  const command = accessKeyCommand(agent.handle)
  return (
    <div id={id} role="region" aria-label={t('tracker.agents.showKey', { name: agent.name })} className="mt-3 ml-11 rounded-lg border border-line bg-stone-50 px-3 py-2.5">
      <p className="text-xs text-stone-600">{t('tracker.agents.keyBody')}</p>
      <div className="mt-2 flex items-start gap-2">
        <code className="min-w-0 flex-1 rounded-md bg-stone-900 px-3 py-2 font-mono text-[12px] leading-relaxed break-all text-stone-100 select-all">{command}</code>
        <Button
          size="sm"
          icon={copied ? <Check /> : <Copy />}
          onClick={() =>
            void navigator.clipboard
              .writeText(command)
              .then(() => {
                setCopied(true)
                showToast({ tone: 'success', title: t('tracker.agents.copied') })
              })
              .catch(() => showToast({ tone: 'error', title: t('tracker.common.actionFailed') }))
          }
        >
          {t('tracker.agents.copy')}
        </Button>
      </div>
    </div>
  )
}

/** Register (`agent` null) or edit an agent. The handle is entered once; editing shows it fixed. */
function AgentDialog({ agent, onClose, onCreated }: { agent: Agent | null; onClose: () => void; onCreated: (agent: Agent) => void }) {
  const { t } = useText()
  const { me } = useReference()
  const { create, update } = useAgentMutations()
  const people = useQuery(peopleQuery(''))
  const [handle, setHandle] = useState(agent?.handle ?? '')
  const [name, setName] = useState(agent?.name ?? '')
  const [ownerSub, setOwnerSub] = useState(agent?.owner.sub ?? me.sub)
  const [description, setDescription] = useState(agent?.description ?? '')
  const [submitted, setSubmitted] = useState(false)
  const mutation = agent ? update : create
  const owners = new Map<string, Person>()
  for (const person of [{ sub: me.sub, name: me.name }, ...(agent ? [agent.owner] : []), ...(people.data?.items ?? [])]) owners.set(person.sub, person)
  const handleError = !agent && !AGENT_HANDLE_PATTERN.test(handle) ? t('tracker.agents.handleInvalid') : isTrackerError(create.error, 'conflict') ? t('tracker.agents.handleTaken') : undefined
  const nameError = !name.trim() ? t('tracker.form.required') : Array.from(name.trim()).length > AGENT_NAME_MAX ? t('tracker.form.tooLong', { max: AGENT_NAME_MAX }) : undefined
  const descriptionError = new TextEncoder().encode(description).length > AGENT_DESCRIPTION_MAX_BYTES ? t('tracker.form.tooLong', { max: AGENT_DESCRIPTION_MAX_BYTES }) : undefined
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if ((handleError && !isTrackerError(create.error, 'conflict')) || nameError || descriptionError || !ownerSub) return
    if (agent) {
      update.mutate({ id: agent.id, input: { name: name.trim(), description, ownerSub } }, { onSuccess: onClose })
      return
    }
    create.mutate(
      { handle, name: name.trim(), description, ownerSub },
      {
        onSuccess: (created) => {
          showToast({ tone: 'success', title: t('tracker.agents.registered', { name: created.name }) })
          onCreated(created)
          onClose()
        },
      }
    )
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={agent ? t('tracker.agents.editLabel', { name: agent.name }) : t('tracker.agents.register')}
      footer={
        <>
          <Button onClick={onClose}>{t('tracker.common.cancel')}</Button>
          <Button tone="primary" type="submit" form="agent-form" loading={mutation.isPending} icon={agent ? undefined : <Bot />}>
            {agent ? t('tracker.common.save') : t('tracker.agents.register')}
          </Button>
        </>
      }
    >
      <form id="agent-form" onSubmit={submit} noValidate className="space-y-4">
        <Field id="agent-handle" label={t('tracker.agents.handle')} required={!agent} hint={agent ? t('tracker.agents.handleFixed') : t('tracker.agents.handleHint')} error={submitted || isTrackerError(create.error, 'conflict') ? handleError : undefined}>
          <div className="relative">
            <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-sm text-stone-400">
              @
            </span>
            <TextInput
              id="agent-handle"
              value={handle}
              disabled={agent !== null}
              invalid={(submitted || isTrackerError(create.error, 'conflict')) && Boolean(handleError)}
              onChange={(event) => {
                setHandle(event.target.value.toLowerCase())
                create.reset()
              }}
              maxLength={31}
              autoComplete="off"
              spellCheck={false}
              className="pl-7 font-mono"
            />
          </div>
        </Field>
        <Field id="agent-name" label={t('tracker.agents.name')} required error={submitted ? nameError : undefined}>
          <TextInput id="agent-name" value={name} invalid={submitted && Boolean(nameError)} onChange={(event) => setName(event.target.value)} maxLength={AGENT_NAME_MAX} />
        </Field>
        <Field id="agent-owner" label={t('tracker.agents.owner')} required hint={t('tracker.agents.ownerHint')}>
          <SelectInput id="agent-owner" value={ownerSub} onChange={(event) => setOwnerSub(event.target.value)}>
            {[...owners.values()].map((person) => (
              <option key={person.sub} value={person.sub}>
                {person.sub === me.sub ? `${person.name} (${t('tracker.nav.you')})` : person.name}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field id="agent-description" label={t('tracker.agents.description')} hint={t('tracker.agents.descriptionHint')} error={descriptionError}>
          <TextArea id="agent-description" rows={3} value={description} invalid={Boolean(descriptionError)} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        {mutation.error && !isTrackerError(mutation.error, 'conflict') ? <ActionError error={mutation.error} /> : null}
      </form>
    </Dialog>
  )
}

/** The workspace's completion policy: two radio cards that say what each choice means for people and agents. */
export function CompletionPolicy() {
  const { t } = useText()
  const { workspace, me } = useReference()
  const update = useUpdateWorkspace()
  const name = useId()
  return (
    <fieldset className="max-w-xl space-y-2" disabled={!me.isAdmin || update.isPending}>
      <legend className="pb-1 text-base font-semibold text-stone-900">{t('tracker.completion.title')}</legend>
      {AGENT_COMPLETIONS.map((policy: AgentCompletion) => (
        <label
          key={policy}
          className={cn(
            'flex cursor-pointer gap-3 rounded-lg border bg-white px-4 py-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
            workspace.agentCompletion === policy ? 'border-accent-line bg-accent-soft/40' : 'border-line hover:border-stone-300'
          )}
        >
          <input type="radio" name={name} value={policy} checked={workspace.agentCompletion === policy} onChange={() => update.mutate({ agentCompletion: policy })} className="mt-1 accent-[var(--color-accent)]" />
          <span>
            <span className="block text-sm font-medium text-stone-900">{t(`tracker.completion.${policy}`)}</span>
            <span className="mt-0.5 block text-[13px] leading-relaxed text-stone-600">{t(`tracker.completion.${policy}Hint`)}</span>
          </span>
        </label>
      ))}
      {update.error ? <ActionError error={update.error} /> : null}
    </fieldset>
  )
}
