// Pure sprint rules shared by screens and the dev mock (API.md "Sprints,
// estimates, burndown and velocity"): the size → point weights, the ledger
// rule (an issue's contribution to its sprint and the signed deltas between
// two standings), membership checks (epics never join, closed sprints are
// frozen, lineage-exclusive), sprint dates in the workspace timezone, the
// burndown and velocity arithmetic, and sectioning a list by sprint.
import type { BurndownPoint, IssueSummary, IssueType, Size, Sprint, SprintLength, SprintRef, SprintState, StatusCategory, Tally, Unit, VelocityEntry } from '../api/tracker'
import type { IssueSection } from './issues'

/** Smallest first; pickers list them in this order. */
export const SIZES: readonly Size[] = ['XS', 'S', 'M', 'L', 'XL']
/** Fixed Fibonacci weights (`domain.SizePoints`); a constant, never a setting. */
export const SIZE_POINTS: Readonly<Record<Size, number>> = { XS: 1, S: 2, M: 3, L: 5, XL: 8 }
export const UNITS: readonly Unit[] = ['points', 'issues']
export const SPRINT_LENGTHS: readonly SprintLength[] = [1, 2]
export const SPRINT_NAME_MAX = 60
export const SPRINT_GOAL_MAX_BYTES = 4096
/** `averagePerWeek` looks at this many most recent closed sprints. */
export const VELOCITY_WINDOW = 3

/** An unestimated issue counts 0 points. */
export function sizePoints(size: Size | null | undefined): number {
  return size ? SIZE_POINTS[size] : 0
}

export const ZERO_TALLY: Tally = { scopePoints: 0, scopeIssues: 0, donePoints: 0, doneIssues: 0 }

export function addTally(a: Tally, b: Tally): Tally {
  return { scopePoints: a.scopePoints + b.scopePoints, scopeIssues: a.scopeIssues + b.scopeIssues, donePoints: a.donePoints + b.donePoints, doneIssues: a.doneIssues + b.doneIssues }
}

export function subtractTally(a: Tally, b: Tally): Tally {
  return { scopePoints: a.scopePoints - b.scopePoints, scopeIssues: a.scopeIssues - b.scopeIssues, donePoints: a.donePoints - b.donePoints, doneIssues: a.doneIssues - b.doneIssues }
}

export const isZeroTally = (tally: Tally) => tally.scopePoints === 0 && tally.scopeIssues === 0 && tally.donePoints === 0 && tally.doneIssues === 0

export const scopeIn = (tally: Tally, unit: Unit) => (unit === 'points' ? tally.scopePoints : tally.scopeIssues)
export const doneIn = (tally: Tally, unit: Unit) => (unit === 'points' ? tally.donePoints : tally.doneIssues)
export const remainingIn = (tally: Tally, unit: Unit) => scopeIn(tally, unit) - doneIn(tally, unit)

/** What the ledger knows about an issue at one moment (`domain.SprintStanding`). */
export type SprintStanding = { sprintId: string | null; size: Size | null; category: StatusCategory | undefined; deleted: boolean }

/** The issue's share of its sprint: zero outside a sprint, when deleted, or when canceled. */
export function contribution(standing: SprintStanding): Tally {
  if (!standing.sprintId || standing.deleted || standing.category === 'canceled') return ZERO_TALLY
  const points = sizePoints(standing.size)
  const done = standing.category === 'completed'
  return { scopePoints: points, scopeIssues: 1, donePoints: done ? points : 0, doneIssues: done ? 1 : 0 }
}

/** `contribution(after) − contribution(before)`, attributed to each standing's sprint; zero tallies are omitted. */
export function sprintDeltas(before: SprintStanding, after: SprintStanding): Map<string, Tally> {
  const deltas = new Map<string, Tally>()
  const add = (sprintId: string | null, tally: Tally) => {
    if (!sprintId) return
    deltas.set(sprintId, addTally(deltas.get(sprintId) ?? ZERO_TALLY, tally))
  }
  add(before.sprintId, subtractTally(ZERO_TALLY, contribution(before)))
  add(after.sprintId, contribution(after))
  for (const [sprintId, tally] of deltas) if (isZeroTally(tally)) deltas.delete(sprintId)
  return deltas
}

/** Why an issue cannot join a sprint (`domain.ValidateMembership`), else undefined. `lineageMembers` counts its ancestors and descendants already there. */
export function membershipProblem(issueType: IssueType, sprintState: SprintState, lineageMembers: number): 'epic' | 'closed' | 'lineage' | undefined {
  if (issueType === 'epic') return 'epic'
  if (sprintState === 'closed') return 'closed'
  if (lineageMembers > 0) return 'lineage'
  return undefined
}

/**
 * The member of `members` that shares a lineage with `issue` (its parent or
 * story, or an issue whose parent or story it is), read from the refs a
 * summary carries; the server checks every depth.
 */
export function lineageConflict(issue: Pick<IssueSummary, 'id' | 'parent' | 'story'>, members: readonly IssueSummary[]): IssueSummary | undefined {
  const ancestors = new Set([issue.parent?.id, issue.story?.id].filter((id): id is string => Boolean(id)))
  return members.find((member) => member.id !== issue.id && (ancestors.has(member.id) || member.parent?.id === issue.id || member.story?.id === issue.id))
}

/**
 * Why the SPA should not offer `sprint` to `issue` (null = backlog): an epic
 * never joins; an issue in a closed sprint is frozen; a closed sprint takes no
 * one; a relative already in that sprint blocks it. `members` are the issues
 * currently in `sprint`.
 */
export function sprintChoiceProblem(
  issue: Pick<IssueSummary, 'id' | 'type' | 'parent' | 'story' | 'sprint'>,
  sprint: Pick<Sprint, 'id' | 'state'> | null,
  members: readonly IssueSummary[] = []
): 'epic' | 'frozen' | 'closed' | 'lineage' | undefined {
  if (issue.type === 'epic') return sprint ? 'epic' : undefined
  if (issue.sprint?.state === 'closed' && issue.sprint.id !== sprint?.id) return 'frozen'
  if (!sprint || sprint.id === issue.sprint?.id) return undefined
  return membershipProblem(issue.type, sprint.state, lineageConflict(issue, members) ? 1 : 0)
}

// --- dates (YYYY-MM-DD in the workspace timezone) ------------------------------

const DAY_MS = 86_400_000
const dayFormats = new Map<string, Intl.DateTimeFormat>()

/** The calendar day of `instant` in `timeZone`. */
export function dayInZone(instant: string | number | Date, timeZone: string): string {
  let format = dayFormats.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    dayFormats.set(timeZone, format)
  }
  return format.format(new Date(instant))
}

const dayValue = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))

export function addDays(day: string, days: number): string {
  return new Date(dayValue(day) + days * DAY_MS).toISOString().slice(0, 10)
}

/** `to − from` in days. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayValue(to) - dayValue(from)) / DAY_MS)
}

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (day: string) => new Date(dayValue(day)).getUTCDay()
export const isWeekend = (day: string) => weekdayOf(day) === 0 || weekdayOf(day) === 6

export const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && addDays(value, 0) === value

/** Inclusive. */
export function dayRange(from: string, to: string): string[] {
  const days: string[] = []
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day)
  return days
}

export function endsOnFor(startsOn: string, lengthWeeks: SprintLength): string {
  return addDays(startsOn, 7 * lengthWeeks - 1)
}

/** The Monday after `today` (a week ahead when today is Monday): a new sprint's default start without others. */
export function comingMonday(today: string): string {
  return addDays(today, ((8 - weekdayOf(today)) % 7) || 7)
}

/** True when [startsOn, endsOn] meets any of `others` (the non-closed sprints). */
export function overlapsAny(span: { startsOn: string; endsOn: string }, others: readonly { startsOn: string; endsOn: string }[]): boolean {
  return others.some((other) => span.startsOn <= other.endsOn && other.startsOn <= span.endsOn)
}

/** Days left including today (0 once past `endsOn`); before the start, the full length. */
export function daysLeft(sprint: Pick<Sprint, 'startsOn' | 'endsOn'>, today: string): number {
  if (today < sprint.startsOn) return daysBetween(sprint.startsOn, sprint.endsOn) + 1
  return Math.max(0, daysBetween(today, sprint.endsOn) + 1)
}

// --- burndown and velocity -------------------------------------------------------

const round2 = (value: number) => Math.round(value * 100) / 100

/** Mon–Fri days in (startsOn, day]. */
function workdaysAfter(startsOn: string, day: string): number {
  let count = 0
  for (let cursor = addDays(startsOn, 1); cursor <= day; cursor = addDays(cursor, 1)) if (!isWeekend(cursor)) count++
  return count
}

/** `ideal` per day: from `start` at `startsOn` to 0 at `endsOn`, falling only on weekdays (flat across Saturday and Sunday). */
export function idealLine(start: number, days: readonly string[]): number[] {
  if (days.length === 0) return []
  const first = days[0]!
  const total = workdaysAfter(first, days[days.length - 1]!)
  return days.map((day) => (total === 0 ? start : round2(start * (1 - workdaysAfter(first, day) / total))))
}

/** A ledger row reduced to the day it falls on (workspace timezone) and its deltas. */
export type LedgerDay = { day: string; tally: Tally }

/**
 * API.md `Burndown.points`: one per day `startsOn..endsOn`; a day sums the
 * rows on or before it (planning rows before the start count on day one), the
 * last day of a closed sprint every row; days after `today` keep only
 * `ideal`. `baseline` (the commitment, or the current tally while planned)
 * sets where `ideal` starts.
 */
export function burndownPoints({
  startsOn,
  endsOn,
  today,
  unit,
  baseline,
  rows,
  closed,
}: {
  startsOn: string
  endsOn: string
  today: string
  unit: Unit
  baseline: Tally
  rows: readonly LedgerDay[]
  closed: boolean
}): BurndownPoint[] {
  const days = dayRange(startsOn, endsOn)
  const ideal = idealLine(remainingIn(baseline, unit), days)
  return days.map((day, index) => {
    if (day > today) return { day, ideal: ideal[index]! }
    const last = closed && day === endsOn
    const sum = rows.filter((row) => last || row.day <= day).reduce((total, row) => addTally(total, row.tally), ZERO_TALLY)
    return { day, scope: scopeIn(sum, unit), done: doneIn(sum, unit), remaining: remainingIn(sum, unit), ideal: ideal[index]! }
  })
}

/** Mean of `completed / lengthWeeks` over the last three entries (oldest first in), 2 decimals; null without any. */
export function averagePerWeek(entries: readonly Pick<VelocityEntry, 'completed' | 'lengthWeeks'>[]): number | null {
  const recent = entries.slice(-VELOCITY_WINDOW)
  if (recent.length === 0) return null
  return round2(recent.reduce((sum, entry) => sum + entry.completed / entry.lengthWeeks, 0) / recent.length)
}

/** What to plan into a sprint of `lengthWeeks`: `averagePerWeek × lengthWeeks`, rounded; null before the first close. */
export function suggestedCommitment(perWeek: number | null, lengthWeeks: SprintLength): number | null {
  return perWeek === null ? null : Math.round(perWeek * lengthWeeks)
}

// --- ordering and sections ------------------------------------------------------

const STATE_ORDER: Record<SprintState, number> = { active: 0, planned: 1, closed: 2 }

/** API.md `GET /sprints` order: active, planned by `startsOn`, closed newest first. */
export function compareSprints(a: Pick<Sprint, 'state' | 'startsOn' | 'number'>, b: Pick<Sprint, 'state' | 'startsOn' | 'number'>): number {
  return STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.state === 'closed' ? b.startsOn.localeCompare(a.startsOn) || b.number - a.number : a.startsOn.localeCompare(b.startsOn) || a.number - b.number)
}

export const sprintRef = (sprint: Pick<Sprint, 'id' | 'number' | 'name' | 'state'>): SprintRef => ({ id: sprint.id, number: sprint.number, name: sprint.name, state: sprint.state })

/** The backlog section's key; also the Filter value for "no sprint". */
export const BACKLOG = 'none'

/** A list section or board lane by sprint (`header` is always null): `sprint` null for the backlog. */
export type SprintSection = IssueSection & { sprint: Sprint | SprintRef | null }

export const isSprintSection = (section: IssueSection): section is SprintSection => 'sprint' in section

/**
 * Rows sectioned by `issue.sprint`: the active and planned sprints always
 * (empty ones too, so rows can be dragged in), closed ones only when they
 * hold rows, in `compareSprints` order, then the backlog (always present).
 * Epics are rows of the backlog. Rows keep their order.
 */
export function groupBySprint(issues: readonly IssueSummary[], sprints: readonly Sprint[]): SprintSection[] {
  const sections = new Map<string, SprintSection>()
  for (const sprint of sprints) if (sprint.state !== 'closed') sections.set(sprint.id, { key: sprint.id, header: null, sprint, issues: [] })
  const backlog: SprintSection = { key: BACKLOG, header: null, sprint: null, issues: [] }
  const known = new Map(sprints.map((sprint) => [sprint.id, sprint]))
  for (const issue of issues) {
    if (!issue.sprint) {
      backlog.issues.push(issue)
      continue
    }
    let section = sections.get(issue.sprint.id)
    if (!section) {
      section = { key: issue.sprint.id, header: null, sprint: known.get(issue.sprint.id) ?? issue.sprint, issues: [] }
      sections.set(issue.sprint.id, section)
    }
    section.issues.push(issue)
  }
  const order = (section: SprintSection) => known.get(section.key) ?? { state: section.sprint!.state, startsOn: '', number: section.sprint!.number }
  return [...[...sections.values()].sort((a, b) => compareSprints(order(a), order(b))), backlog]
}

/** Scope of these issues in `unit`: not canceled; points sum their sizes. */
export function scopeOf(issues: readonly IssueSummary[], category: (statusId: string) => StatusCategory | undefined, unit: Unit): number {
  const counted = issues.filter((issue) => category(issue.statusId) !== 'canceled')
  return unit === 'points' ? counted.reduce((sum, issue) => sum + sizePoints(issue.estimate), 0) : counted.length
}

/** The close dialog's counts over a sprint's members: done (completed) and unfinished (scope not done); canceled ones stay behind uncounted. */
export function closeCounts(members: readonly IssueSummary[], category: (statusId: string) => StatusCategory | undefined): { done: number; unfinished: number } {
  let done = 0
  let unfinished = 0
  for (const issue of members) {
    const value = category(issue.statusId)
    if (value === 'completed') done++
    else if (value !== 'canceled') unfinished++
  }
  return { done, unfinished }
}
