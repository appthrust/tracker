// Pure agent rules shared by screens and the dev mock (API.md "Agents: people
// and AI agents on the same board"): actor kinds and agent subjects, the run
// lease (`stalled` is derived from `leaseExpiresAt`), who may answer,
// withdraw or cancel, the completion policy, "Actionable" and its order,
// `@handle` mentions, and the request wait statistics the agents settings
// page shows.
import type { Actor, AgentCompletion, AgentInfo, Priority, RequestKind, Run, RunState, StatusCategory, TrackerRequest } from '../api/tracker'

/** `^[a-z][a-z0-9-]{1,30}$`: what people type (`@astra`) and the `external` subject of the agent's Access Keys. */
export const AGENT_HANDLE_PATTERN = /^[a-z][a-z0-9-]{1,30}$/
export const AGENT_NAME_MAX = 60
export const AGENT_DESCRIPTION_MAX_BYTES = 4096
/** A run's lease; every heartbeat renews it for this long. */
export const LEASE_MS = 10 * 60_000
/** `session` and `note`, in characters. */
export const RUN_TEXT_MAX = 200
export const RUN_SUMMARY_MAX_BYTES = 20_480
export const RUN_LINKS_MAX = 10
export const LINK_TITLE_MAX = 200
export const REQUEST_TITLE_MAX = 200
export const REQUEST_BODY_MAX_BYTES = 20_480
export const REQUEST_OPTIONS_MAX = 6
export const IDEMPOTENCY_KEY_MAX = 128
/** The fixed options of an `approval` and a `review`. */
export const DECISION_OPTIONS: readonly string[] = ['approve', 'reject']
export const RUN_STATES: readonly RunState[] = ['running', 'waiting', 'stalled', 'succeeded', 'failed', 'canceled']
export const REQUEST_KINDS: readonly RequestKind[] = ['question', 'approval', 'review']
export const AGENT_COMPLETIONS: readonly AgentCompletion[] = ['review', 'direct']
/** The scopes of the existing `tracker` space: `GET` needs read, every other method write. */
export const ACCESS_KEY_SCOPES: readonly string[] = ['tracker:read', 'tracker:write']

const AGENT_PREFIX = 'agent:'

export const agentSub = (id: string) => `${AGENT_PREFIX}${id}`
/** The agent id in an `agent:<id>` subject, else null (a person). */
export const agentIdOf = (sub: string): string | null => (sub.startsWith(AGENT_PREFIX) ? sub.slice(AGENT_PREFIX.length) : null)

export function isAgent(actor: Pick<Actor, 'kind'> | null | undefined): actor is Actor & { kind: 'agent'; agent: AgentInfo } {
  return actor?.kind === 'agent'
}

/** The platform command an Admin runs to mint a key for this agent; Tracker never sees or shows the key. */
export function accessKeyCommand(handle: string): string {
  return `apth access-keys create --space tracker --external ${handle} ${ACCESS_KEY_SCOPES.map((scope) => `--scope ${scope}`).join(' ')}`
}

// --- runs ------------------------------------------------------------------------

export type StoredRunState = Exclude<RunState, 'stalled'>

export const isTerminalRun = (state: RunState) => state === 'succeeded' || state === 'failed' || state === 'canceled'
/** Running or waiting: the agent is working (a stalled run is not live). */
export const isLiveRun = (run: { state: RunState } | null | undefined): boolean => run?.state === 'running' || run?.state === 'waiting'

/** The state readers see: a non-terminal run whose lease has passed (`leaseExpiresAt <= now`) is `stalled`. */
export function deriveRunState(stored: StoredRunState, leaseExpiresAt: string, now: number): RunState {
  return !isTerminalRun(stored) && Date.parse(leaseExpiresAt) <= now ? 'stalled' : stored
}

/** Milliseconds since the last heartbeat. */
export const heartbeatAge = (run: Pick<Run, 'heartbeatAt'>, now: number) => Math.max(0, now - Date.parse(run.heartbeatAt))

// --- authorization rows the SPA needs (API.md "Authorization") ---------------------

type Caller = Pick<Actor, 'sub' | 'kind'> & { isAdmin?: boolean }
/** The parts of a request the rules read (the mock passes stored subjects). */
type RequestShape = { kind: RequestKind; state: TrackerRequest['state']; from: { sub: string }; to: { sub: string } | null }

/** Whether `caller` may answer this request now: questions by their addressee (any person when unaddressed); approvals and reviews only by people — the addressee, any person when unaddressed, or an Admin. */
export function canAnswer(request: RequestShape, caller: Caller): boolean {
  if (request.state !== 'open') return false
  if (request.kind === 'question') return request.to ? request.to.sub === caller.sub : caller.kind === 'person' && request.from.sub !== caller.sub
  if (caller.kind !== 'person') return false
  return request.to === null || request.to.sub === caller.sub || caller.isAdmin === true
}

/** The requester withdraws its own open request. */
export const canWithdraw = (request: Pick<RequestShape, 'from' | 'state'>, caller: Caller) => request.state === 'open' && request.from.sub === caller.sub

/** Any person, or the run's own agent, cancels a run that has not ended (a stalled one included). */
export const canCancelRun = (run: { agent: { sub: string }; state: RunState }, caller: Caller) => !isTerminalRun(run.state) && (caller.kind === 'person' || run.agent.sub === caller.sub)

/** People always set a completed status; agents only under the `direct` policy. */
export const maySetCompleted = (kind: Actor['kind'], policy: AgentCompletion) => kind === 'person' || policy === 'direct'

/** An open request in the caller's queue: addressed to them, or to any person when the caller is a person (not their own). */
export function isAddressedTo(request: Pick<RequestShape, 'to' | 'from' | 'state'>, caller: Caller): boolean {
  if (request.state !== 'open') return false
  return request.to ? request.to.sub === caller.sub : caller.kind === 'person' && request.from.sub !== caller.sub
}

// --- Actionable (domain.Actionable) ---------------------------------------------------

/** What "Actionable" reads about one issue for one agent. `activeRun` carries the derived state; `ownOpenRequest` ignores requests on stalled runs. */
export type ActionableStanding = {
  deleted: boolean
  category: StatusCategory | undefined
  activeRun: { state: RunState; agent: { sub: string } } | null
  agentSub: string
  ownOpenRequest: boolean
  openBlocker: boolean
}

/** Not deleted; backlog, unstarted or started; no live run of another agent; no open request the agent raised on it; no blocker outside completed/canceled. */
export function isActionable(standing: ActionableStanding): boolean {
  if (standing.deleted) return false
  if (standing.category !== 'backlog' && standing.category !== 'unstarted' && standing.category !== 'started') return false
  if (standing.activeRun && isLiveRun(standing.activeRun) && standing.activeRun.agent.sub !== standing.agentSub) return false
  return !standing.ownOpenRequest && !standing.openBlocker
}

const PRIORITY_ORDER: readonly Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

/** Priority, then active-sprint members first, then number. */
export function compareActionable(activeSprintId: string | null) {
  return (a: { priority: Priority; sprint: { id: string } | null; number: number }, b: { priority: Priority; sprint: { id: string } | null; number: number }) => {
    const inActive = (issue: { sprint: { id: string } | null }) => (activeSprintId !== null && issue.sprint?.id === activeSprintId ? 0 : 1)
    return PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || inActive(a) - inActive(b) || a.number - b.number
  }
}

// --- mentions --------------------------------------------------------------------------

const MENTION = /(^|[^A-Za-z0-9_@.-])@([a-z][a-z0-9-]{1,30})(?![A-Za-z0-9_-])/g

/** The known handles a body `@mentions`, once each, in order of first appearance. */
export function parseMentions(body: string, handles: readonly string[]): string[] {
  const found: string[] = []
  for (const match of body.matchAll(MENTION)) {
    const handle = match[2]!
    if (handles.includes(handle) && !found.includes(handle)) found.push(handle)
  }
  return found
}

/** The `@…` word being typed at `caret` (its start index and the text after `@`), else null: autocomplete opens on it. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = before.match(/(^|[^A-Za-z0-9_@.-])@([a-z0-9-]{0,31})$/)
  if (!match) return null
  return { start: caret - match[2]!.length - 1, query: match[2]! }
}

// --- statistics ------------------------------------------------------------------------

/** Median milliseconds an agent's requests waited for a person (answered ones only), null without any. */
export function medianWaitMs(requests: readonly Pick<TrackerRequest, 'from' | 'createdAt' | 'answer' | 'state'>[]): number | null {
  const waits = requests
    .filter((request) => request.state === 'answered' && isAgent(request.from) && request.answer && request.answer.by.kind === 'person')
    .map((request) => Date.parse(request.answer!.at) - Date.parse(request.createdAt))
    .sort((a, b) => a - b)
  if (waits.length === 0) return null
  const middle = Math.floor(waits.length / 2)
  return waits.length % 2 === 1 ? waits[middle]! : (waits[middle - 1]! + waits[middle]!) / 2
}
