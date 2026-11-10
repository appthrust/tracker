// `/epics`: every epic with its progress and its stories (each with its own
// progress), how many work items hang directly under each, a link into the
// list filtered to it (`filter.epic` / `filter.story`), and "New epic" / "New
// story". Stories without an epic follow; the count of work items in no epic
// or story closes the page. Every issue loads (all pages) so the counts are
// complete. The `?project=` scope keeps an epic or story while it, or any of
// its work, is in that project, and then counts only that project's work.
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, Plus } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { allIssuesQuery } from '../../api/queries'
import type { IssueSummary } from '../../api/tracker'
import { useText } from '../../i18n'
import { levelOf, NO_GROUP, tallyProgress } from '../../model/issues'
import { listHref, paths } from '../../routes/paths'
import { Button, EmptyState, HrefLink, Loading, LoadFailed, useDocumentTitle } from '../../ui'
import { setUi } from '../ui-state'
import { NO_PROJECT, ProjectScopeSwitcher } from './projects'
import { useReference } from './use-reference'
import { ProgressBar, StatusIcon, TypeIcon } from './visuals'

const everyIssue = allIssuesQuery({}, 'number')

type StoryRow = { story: IssueSummary; work: IssueSummary[]; direct: number }
type EpicRow = { epic: IssueSummary; stories: StoryRow[]; work: IssueSummary[]; direct: number }

export function EpicsPage({ project }: { project?: string }) {
  const { t } = useText()
  const navigate = useNavigate()
  const { statuses, statusById, projectById } = useReference()
  const query = useQuery(everyIssue)
  const scope = project ?? null
  const scopeProject = scope && scope !== NO_PROJECT ? projectById.get(scope) : undefined
  const scopeName = scope === NO_PROJECT ? t('tracker.project.none') : scope ? (scopeProject?.name ?? t('tracker.project.unknown')) : undefined
  useDocumentTitle(scopeName ? `${scopeName} · ${t('tracker.nav.epics')}` : t('tracker.nav.epics'))
  // Like the list and board, the overview hands its scope to the shell (new issues, sidebar links).
  useEffect(() => setUi({ scope }), [scope])

  const { epics, orphans, unbundled } = useMemo(() => {
    const items = query.data?.items ?? []
    const inScope = (issue: IssueSummary) => !scope || (scope === NO_PROJECT ? issue.projectId === null : issue.projectId === scope)
    const work = items.filter((issue) => levelOf(issue.type) === 0 && inScope(issue))
    const storyRow = (story: IssueSummary): StoryRow => {
      const under = work.filter((issue) => issue.story?.id === story.id)
      return { story, work: under, direct: under.filter((issue) => issue.parent?.id === story.id).length }
    }
    const stories = items.filter((issue) => issue.type === 'story').map(storyRow)
    const visibleStory = (row: StoryRow) => inScope(row.story) || row.work.length > 0
    const epicRows: EpicRow[] = items
      .filter((issue) => issue.type === 'epic')
      .map((epic) => {
        const under = work.filter((issue) => issue.epic?.id === epic.id)
        const own = stories.filter((row) => row.story.epic?.id === epic.id && visibleStory(row))
        return { epic, stories: own, work: under, direct: under.filter((issue) => issue.parent?.id === epic.id).length }
      })
      .filter((row) => inScope(row.epic) || row.work.length > 0 || row.stories.length > 0)
    return {
      epics: epicRows,
      orphans: stories.filter((row) => row.story.epic === null && visibleStory(row)),
      unbundled: work.filter((issue) => issue.epic === null && issue.story === null).length,
    }
  }, [query.data, scope])

  // Unscoped, the server's progress is authoritative; scoped, only that project's work counts.
  const progress = (issue: IssueSummary, work: IssueSummary[]) => (scope || !issue.progress ? tallyProgress(work, statuses) : issue.progress)
  const defaultProject = scopeProject && !scopeProject.archived ? scopeProject.id : null
  const newEpic = () => setUi({ newIssue: { type: 'epic', projectId: defaultProject } })
  const newStory = (epic: IssueSummary) => setUi({ newIssue: { type: 'story', parent: epic, projectId: defaultProject } })
  const issuesOf = (kind: 'epic' | 'story', id: string) => listHref(paths.home, { filter: { [kind]: [id] }, group: kind === 'epic' ? 'story' : undefined, project: scope })

  const viewLink = (kind: 'epic' | 'story', issue: IssueSummary) => (
    <HrefLink
      href={issuesOf(kind, issue.id)}
      aria-label={t('tracker.epics.viewIssuesOf', { name: issue.title })}
      title={t('tracker.epics.viewIssuesOf', { name: issue.title })}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-stone-600 hover:bg-stone-100 hover:text-stone-900"
    >
      <span className="max-sm:sr-only">{t('tracker.epics.viewIssues')}</span>
      <ArrowRight aria-hidden className="size-3.5" />
    </HrefLink>
  )
  const title = (issue: IssueSummary, strong: boolean) => (
    <HrefLink href={paths.issue(issue.identifier)} className="flex min-w-0 items-center gap-2 hover:underline">
      <span className="shrink-0 font-mono text-xs text-stone-500">{issue.identifier}</span>
      <span className={strong ? 'truncate text-[15px] font-semibold text-stone-900' : 'truncate text-[13px] text-stone-800'}>{issue.title}</span>
    </HrefLink>
  )
  const status = (issue: IssueSummary) => {
    const current = statusById.get(issue.statusId)
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-stone-500">
        <StatusIcon status={current} />
        <span className="max-md:sr-only">{current?.name}</span>
      </span>
    )
  }
  const storyList = (rows: StoryRow[]) => (
    <ul className="divide-y divide-stone-100">
      {rows.map(({ story, work, direct }) => (
        <li key={story.id} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-1.5 pr-2 pl-3 sm:pl-9">
          <TypeIcon type="story" />
          <div className="min-w-0 flex-1">{title(story, false)}</div>
          {status(story)}
          <ProgressBar progress={progress(story, work)} />
          <span className="w-28 shrink-0 text-right text-xs text-stone-500 tabular-nums max-sm:hidden">{t('tracker.epics.directCount', { count: direct })}</span>
          {viewLink('story', story)}
        </li>
      ))}
    </ul>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-white px-4 sm:px-6">
        <h1 className="min-w-0 shrink-0 truncate text-[15px] font-semibold text-stone-900">{t('tracker.nav.epics')}</h1>
        <ProjectScopeSwitcher value={scope} many={0} onChange={(next) => void navigate({ to: paths.epics, search: next ? { project: next } : {}, replace: true } as never)} />
        <div className="ml-auto flex items-center gap-1.5">
          <Button tone="primary" size="sm" icon={<Plus />} onClick={newEpic}>
            {t('tracker.epics.newEpic')}
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={query.isFetching || undefined}>
        <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6">
          {query.isPending ? (
            <Loading />
          ) : query.isError ? (
            <LoadFailed error={query.error} onRetry={() => void query.refetch()} />
          ) : epics.length === 0 && orphans.length === 0 ? (
            <EmptyState
              icon={<TypeIcon type="epic" className="size-6" />}
              title={t('tracker.epics.emptyTitle')}
              body={t('tracker.epics.emptyBody')}
              action={
                <Button tone="primary" icon={<Plus />} onClick={newEpic}>
                  {t('tracker.epics.newEpic')}
                </Button>
              }
            />
          ) : (
            <>
              {scopeName ? <p className="text-xs text-stone-500">{t('tracker.epics.scoped', { name: scopeName })}</p> : null}
              {epics.map(({ epic, stories, work, direct }) => (
                <section key={epic.id} aria-label={`${epic.identifier} ${epic.title}`} className="rounded-lg border border-line bg-white">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
                    <TypeIcon type="epic" className="size-4" />
                    <div className="min-w-0 flex-1">{title(epic, true)}</div>
                    {status(epic)}
                    <ProgressBar progress={progress(epic, work)} className="[&>[role=progressbar]]:w-28" />
                    <div className="flex basis-full items-center gap-3 pl-7 text-xs text-stone-500 tabular-nums">
                      <span>{t('tracker.epics.storyCount', { count: stories.length })}</span>
                      <span aria-hidden>·</span>
                      <span>{t('tracker.epics.directCount', { count: direct })}</span>
                      <span className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => newStory(epic)}
                          aria-label={t('tracker.epics.newStoryIn', { name: epic.title })}
                          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-stone-600 hover:bg-stone-100 hover:text-stone-900"
                        >
                          <Plus aria-hidden className="size-3.5" />
                          {t('tracker.epics.newStory')}
                        </button>
                        {viewLink('epic', epic)}
                      </span>
                    </div>
                  </div>
                  <div className="border-t border-stone-100">
                    {stories.length > 0 ? storyList(stories) : <p className="py-2.5 pl-3 text-xs text-stone-400 sm:pl-9">{t('tracker.epics.noStories')}</p>}
                  </div>
                </section>
              ))}
              {orphans.length > 0 ? (
                <section aria-labelledby="orphan-stories" className="rounded-lg border border-dashed border-stone-300 bg-white">
                  <h2 id="orphan-stories" className="px-3 py-2.5 text-[13px] font-medium text-stone-600">
                    {t('tracker.epics.noEpic')}
                  </h2>
                  <div className="border-t border-stone-100">{storyList(orphans)}</div>
                </section>
              ) : null}
              {unbundled > 0 ? (
                <p className="flex flex-wrap items-center gap-2 px-1 text-xs text-stone-500">
                  {t('tracker.epics.unbundled', { count: unbundled })}
                  <HrefLink href={listHref(paths.home, { filter: { epic: [NO_GROUP], story: [NO_GROUP] }, project: scope })} className="inline-flex items-center gap-1 font-medium text-accent-strong hover:underline">
                    {t('tracker.epics.viewIssues')}
                    <ArrowRight aria-hidden className="size-3.5" />
                  </HrefLink>
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
