// Pure issue rules shared by screens and the dev mock: category and priority
// order, list sorting (API.md `Sort`), filter matching (API.md `Filter`), the
// epic › story › work item hierarchy and the list/board grouping built on it
// (API.md "Epics and stories"), and the attachments an issue's timeline
// carries (there is no attachment-list route; `attachment` activities hold
// the Attachment in `to` when added and in `from` when removed).
import type { Attachment, Filter, GroupBy, IssueRef, IssueSummary, IssueType, Priority, Progress, Report, Sort, Status, StatusCategory, Surface, TimelineItem } from '../api/tracker'

export const CATEGORIES: readonly StatusCategory[] = ['backlog', 'unstarted', 'started', 'completed', 'canceled']
export const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
/** Highest level first: epic, story, then the work item types. */
export const ISSUE_TYPES: readonly IssueType[] = ['epic', 'story', 'bug', 'feature', 'task']
/** Level-0 types: a unit of work. */
export const WORK_ITEM_TYPES: readonly IssueType[] = ['bug', 'feature', 'task']
export const GROUP_BYS: readonly GroupBy[] = ['none', 'epic', 'story']
export const SURFACES: readonly Surface[] = ['dashboard', 'platform-api', 'apth', 'builder-console', 'console-app', 'cluster', 'other']
export const SORTS: readonly Sort[] = ['updated', 'created', 'priority', 'number']
export const ENVIRONMENT_SUGGESTIONS: readonly string[] = ['appthrust.ink', 'craftsman', 'appthrust.dev', 'local']

export const TITLE_MAX = 200
export const REPORT_TEXT_MAX = 4096
export const PROJECT_NAME_MAX = 60
export const PROJECT_DESCRIPTION_MAX_BYTES = 4096
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024
export const ATTACHMENTS_PER_ISSUE = 10
export const ATTACHMENT_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'text/plain', 'application/json']

/** Statuses in board/list order: by category, then position. */
export function orderStatuses(statuses: readonly Status[]): Status[] {
  return [...statuses].sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.position - b.position)
}

/** `APT-12` → true; identifiers are case-insensitive. */
export function isIdentifier(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]{1,5}-\d+$/.test(value)
}

/** `epic` 2, `story` 1, every work item type 0. */
export function levelOf(type: IssueType): 0 | 1 | 2 {
  return type === 'epic' ? 2 : type === 'story' ? 1 : 0
}

/** Whether an issue of `childType` may sit under one of `parentType` (null = no parent): work items anywhere, otherwise only under a higher level. */
export function canParent(childType: IssueType, parentType: IssueType | null): boolean {
  return parentType === null || levelOf(childType) === 0 || levelOf(parentType) > levelOf(childType)
}

/**
 * The level of the issue's direct parent, read from its derived refs: the
 * parent is its epic (2) or its story (1), else a work item (0); null without a parent.
 */
export function parentLevelOf(issue: Pick<IssueSummary, 'parent' | 'epic' | 'story'>): number | null {
  if (!issue.parent) return null
  if (issue.parent.id === issue.epic?.id) return 2
  if (issue.parent.id === issue.story?.id) return 1
  return 0
}

/** Whether an issue whose parent has `parentLevel` and whose direct children have `childTypes` may become `type`. */
export function canBeType(type: IssueType, parentLevel: number | null, childTypes: readonly IssueType[]): boolean {
  const fitsParent = parentLevel === null || levelOf(type) === 0 || parentLevel > levelOf(type)
  return fitsParent && childTypes.every((child) => canParent(child, type))
}

/** The number in `KEY-123`. */
export function issueNumber(issue: Pick<IssueRef, 'identifier'> & { number?: number }): number {
  return issue.number ?? Number(issue.identifier.slice(issue.identifier.lastIndexOf('-') + 1))
}

export function compareIssues(sort: Sort): (a: IssueSummary, b: IssueSummary) => number {
  const updatedDesc = (a: IssueSummary, b: IssueSummary) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number
  switch (sort) {
    case 'created':
      return (a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number
    case 'priority':
      return (a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || updatedDesc(a, b)
    case 'number':
      return (a, b) => a.number - b.number
    default:
      return updatedDesc
  }
}

type FilterContext = { me: string; statuses: readonly Status[]; description?: (issue: IssueSummary) => string }

/** Whether `issue` passes every set facet of `filter` (facets AND, values within a facet OR). */
export function matchesFilter(issue: IssueSummary, filter: Filter, context: FilterContext): boolean {
  const has = <T,>(values: readonly T[] | undefined, value: T) => !values || values.length === 0 || values.includes(value)
  if (!has(filter.status, issue.statusId)) return false
  if (filter.category && filter.category.length > 0) {
    const category = context.statuses.find((status) => status.id === issue.statusId)?.category
    if (!category || !filter.category.includes(category)) return false
  }
  if (filter.assignee && filter.assignee.length > 0) {
    const ok = filter.assignee.some((value) =>
      value === 'none' ? issue.assignee === null : value === 'me' ? issue.assignee?.sub === context.me : issue.assignee?.sub === value
    )
    if (!ok) return false
  }
  if (filter.reporter && filter.reporter.length > 0 && !filter.reporter.some((value) => issue.reporter.sub === (value === 'me' ? context.me : value))) return false
  if (filter.label && filter.label.length > 0 && !filter.label.some((label) => issue.labelIds.includes(label))) return false
  if (!has(filter.type, issue.type)) return false
  if (!has(filter.priority, issue.priority)) return false
  if (filter.createdAfter && issue.createdAt <= new Date(filter.createdAfter).toISOString()) return false
  if (filter.environment && filter.environment.length > 0 && !filter.environment.includes(issue.report?.environment ?? '')) return false
  if (filter.surface && filter.surface.length > 0 && (!issue.report || !filter.surface.includes(issue.report.surface))) return false
  if (filter.parent) {
    if (filter.parent === 'none' ? issue.parent !== null : issue.parent?.id !== filter.parent) return false
  }
  if (filter.project && filter.project.length > 0 && !filter.project.some((value) => (value === 'none' ? issue.projectId === null : issue.projectId === value))) return false
  if (filter.epic && filter.epic.length > 0 && !filter.epic.some((value) => (value === 'none' ? issue.epic === null : issue.epic?.id === value))) return false
  if (filter.story && filter.story.length > 0 && !filter.story.some((value) => (value === 'none' ? issue.story === null : issue.story?.id === value))) return false
  const q = filter.q?.trim().toLowerCase()
  if (q) {
    const text = `${issue.identifier} ${issue.title} ${context.description?.(issue) ?? ''}`.toLowerCase()
    if (!q.split(/\s+/).every((word) => text.includes(word))) return false
  }
  return true
}

/** Drops empty facets, so `{}` means "no filter" and saved views stay minimal. */
export function compactFilter(filter: Filter): Filter {
  const out: Filter = {}
  for (const [key, value] of Object.entries(filter) as [keyof Filter, Filter[keyof Filter]][]) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value) && value.length === 0) continue
    ;(out as Record<string, unknown>)[key] = value
  }
  return out
}

export function isEmptyFilter(filter: Filter): boolean {
  return Object.keys(compactFilter(filter)).length === 0
}

/** Section key of the issues without an epic (resp. story); also the Filter value for "none". */
export const NO_GROUP = 'none'

/** A list section or board lane: `header` is the grouping issue (its summary when known, else the ref the rows carry), null for "no epic/story" or no grouping. */
export type IssueSection = { key: string; header: IssueSummary | IssueRef | null; issues: IssueSummary[] }

export const isSummary = (header: IssueSummary | IssueRef): header is IssueSummary => 'type' in header

/**
 * API.md grouping: with `groupBy` epic (story), rows are sectioned by
 * `issue.epic?.id` (`issue.story?.id`), sections ordered by the group's
 * number, the "none" section (key `none`, always present) last. Issues of the
 * grouping type head their section (with no rows, an empty section) and,
 * like higher levels, are never rows. `known` supplies summaries for groups
 * the rows only reference (their status and progress). Rows keep their order.
 * `none` gives one section with every issue.
 */
export function groupIssues(issues: readonly IssueSummary[], groupBy: GroupBy, known: readonly IssueSummary[] = []): IssueSection[] {
  if (groupBy === 'none') return [{ key: 'all', header: null, issues: [...issues] }]
  const level = levelOf(groupBy)
  const lookup = new Map(known.filter((issue) => issue.type === groupBy).map((issue) => [issue.id, issue]))
  const sections = new Map<string, IssueSection>()
  const none: IssueSection = { key: NO_GROUP, header: null, issues: [] }
  const sectionFor = (header: IssueSummary | IssueRef) => {
    const existing = sections.get(header.id)
    if (existing) {
      if (isSummary(header) && !isSummary(existing.header!)) existing.header = header
      return existing
    }
    const section: IssueSection = { key: header.id, header: isSummary(header) ? header : (lookup.get(header.id) ?? header), issues: [] }
    sections.set(header.id, section)
    return section
  }
  for (const issue of issues) {
    if (issue.type === groupBy) sectionFor(issue)
    if (levelOf(issue.type) >= level) continue
    const ref = issue[groupBy]
    ;(ref ? sectionFor(ref) : none).issues.push(issue)
  }
  return [...[...sections.values()].sort((a, b) => issueNumber(a.header!) - issueNumber(b.header!)), none]
}

/** API.md `Progress` over these issues: work items only, `total` without canceled ones, `completed` those in a completed status. */
export function tallyProgress(issues: readonly IssueSummary[], statuses: readonly Status[]): Progress {
  const category = new Map(statuses.map((status) => [status.id, status.category]))
  const counted = issues.filter((issue) => levelOf(issue.type) === 0 && category.get(issue.statusId) !== 'canceled')
  return { total: counted.length, completed: counted.filter((issue) => category.get(issue.statusId) === 'completed').length }
}

/** Attachments currently on the issue, oldest first, from its timeline. */
export function attachmentsOf(timeline: readonly TimelineItem[]): Attachment[] {
  const current = new Map<string, Attachment>()
  for (const item of timeline) {
    if (item.kind !== 'activity' || item.activity.field !== 'attachment') continue
    const { from, to } = item.activity
    if (isAttachment(to)) current.set(to.id, to)
    else if (isAttachment(from)) current.delete(from.id)
  }
  return [...current.values()]
}

export function isAttachment(value: unknown): value is Attachment {
  return typeof value === 'object' && value !== null && typeof (value as Attachment).id === 'string' && typeof (value as Attachment).url === 'string'
}

export const isImage = (mediaType: string) => mediaType.startsWith('image/')

/** Why a file cannot be attached (API.md limits), else undefined. */
export function attachmentProblem(file: { size: number; type: string }, existing: number): 'tooLarge' | 'type' | 'tooMany' | undefined {
  if (existing >= ATTACHMENTS_PER_ISSUE) return 'tooMany'
  if (!ATTACHMENT_TYPES.includes(file.type)) return 'type'
  if (file.size > ATTACHMENT_MAX_BYTES || file.size === 0) return 'tooLarge'
  return undefined
}

export type ReportDraft = { environment: string; surface: Surface | ''; version: string; steps: string; expected: string; actual: string }

/** Field problems of a bug report form, keyed by field. */
export function reportProblems(title: string, report: ReportDraft): Partial<Record<'title' | keyof ReportDraft, 'required' | 'tooLong'>> {
  const problems: Partial<Record<'title' | keyof ReportDraft, 'required' | 'tooLong'>> = {}
  if (!title.trim()) problems.title = 'required'
  else if (Array.from(title.trim()).length > TITLE_MAX) problems.title = 'tooLong'
  if (!report.environment.trim()) problems.environment = 'required'
  if (!report.surface) problems.surface = 'required'
  for (const key of ['environment', 'version', 'steps', 'expected', 'actual'] as const) {
    if (!problems[key] && report[key].length > REPORT_TEXT_MAX) problems[key] = 'tooLong'
  }
  return problems
}

/** The API `Report` for a valid draft; optional texts are omitted when blank. */
export function toReport(report: ReportDraft): Report {
  const out: Report = { environment: report.environment.trim(), surface: report.surface as Surface }
  for (const key of ['version', 'steps', 'expected', 'actual'] as const) {
    const value = report[key].trim()
    if (value) out[key] = value
  }
  return out
}
