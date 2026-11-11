// Actors on screen: an agent is visibly not a person (the Avatar's robot
// square, never a photo) and always says who is responsible for it — in the
// badge's accessible name and tooltip where only the badge fits, and as
// visible text wherever the name is written out.
import type { Actor } from '../../api/tracker'
import { useText } from '../../i18n'
import { isAgent } from '../../model/agents'
import { Avatar, cn } from '../../ui'

/** The badge of a person or an agent; agents carry "name, owned by …" as their accessible name and tooltip. */
export function ActorAvatar({ actor, size = 'xs' }: { actor: Actor; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const { t } = useText()
  const label = isAgent(actor) ? t('tracker.agent.avatarLabel', { name: actor.name, owner: actor.agent.owner.name }) : undefined
  return <Avatar person={actor} size={size} label={label} />
}

/** "Astra [Agent] · Owned by Sam Rivera" (the owner line can be dropped where space is short), or a person's name. */
export function ActorName({ actor, owner = true, className }: { actor: Actor; owner?: boolean; className?: string }) {
  const { t } = useText()
  if (!isAgent(actor)) return <span className={cn('truncate', className)}>{actor.name}</span>
  return (
    <span className={cn('inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5', className)}>
      <span className="truncate">{actor.name}</span>
      <AgentTag disabled={actor.agent.disabled} />
      {owner ? <span className="truncate text-[11px] font-normal text-stone-500">{t('tracker.agent.ownedBy', { name: actor.agent.owner.name })}</span> : null}
    </span>
  )
}

/** The small "Agent" (or "Disabled") tag next to an agent's name. */
export function AgentTag({ disabled = false }: { disabled?: boolean }) {
  const { t } = useText()
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded px-1 text-[10px] leading-4 font-medium ring-1 ring-inset', disabled ? 'bg-stone-100 text-stone-500 ring-stone-200' : 'bg-stone-800 text-white ring-stone-900')}>
      {disabled ? t('tracker.agent.disabled') : t('tracker.agent.badge')}
    </span>
  )
}
