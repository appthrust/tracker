// `/inbox`: the person's queue of agent work. Open requests first (oldest
// first, each answerable in place), then updates — answers to the caller's
// own questions and mentions — to acknowledge. Keyboard: J/K (or ↓/↑) move,
// 1–6 choose an option and Enter sends it (Enter on an update or with nothing
// chosen opens the issue as a side panel tab), O opens the issue, E marks an
// update as read, Esc closes the active panel tab; with the panel open J/K
// browse within the active tab. After an answer the next item takes
// focus, so a run of decisions needs no mouse.
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { CheckCheck, Inbox } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { inboxQuery, useAckInbox } from '../../api/queries'
import type { InboxItem } from '../../api/tracker'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { Button, cn, EmptyState, formatDateTime, formatRelative, HrefLink, Loading, LoadFailed, Markdown, useDocumentTitle } from '../../ui'
import { IssuePanel } from '../issues/issue-detail'
import { usePanelTabs } from '../issues/use-panel-tabs'
import { isPlainShortcut } from '../ui-state'
import { ActorAvatar, ActorName } from './actor'
import { optionText, RequestCard } from './request-card'
import { OpenRequestMarker, RunLine } from './run-status'

/** A stable key per item: requests and answers by request id, mentions by comment id, assignments by issue id. */
const itemKey = (item: InboxItem) =>
  item.kind === 'request' ? `request:${item.request.id}` : item.kind === 'answer' ? `answer:${item.request.id}` : item.kind === 'mention' ? `mention:${item.comment.id}` : `assignment:${item.issue.id}`
const itemIssue = (item: InboxItem) => (item.kind === 'request' || item.kind === 'answer' ? item.request.issue : item.issue)

export function InboxPage({ search }: { search: { issue?: string } }) {
  const { t } = useText()
  const navigate = useNavigate()
  useDocumentTitle(t('tracker.nav.inbox'))
  const inbox = useQuery(inboxQuery)
  const ack = useAckInbox()
  const items = useMemo(() => inbox.data ?? [], [inbox.data])
  const requests = items.filter((item) => item.kind === 'request')
  const updates = items.filter((item) => item.kind === 'answer' || item.kind === 'mention')
  const assignments = items.filter((item) => item.kind === 'assignment')
  const ordered = useMemo(() => [...items.filter((item) => item.kind === 'request'), ...items.filter((item) => item.kind === 'answer' || item.kind === 'mention'), ...items.filter((item) => item.kind === 'assignment')], [items])
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const lastIndex = useRef(0)

  const setIssue = useCallback(
    (issue: string | undefined, replace: boolean) => void navigate({ to: paths.inbox, search: issue ? { issue } : {}, replace, resetScroll: false } as never),
    [navigate]
  )
  const panel = usePanelTabs(search.issue, setIssue)
  const { open, browse, close } = panel
  const acknowledge = useCallback((item: InboxItem) => {
    if (item.kind === 'answer') ack.mutate({ answers: [item.request.id] })
    else if (item.kind === 'mention') ack.mutate({ mentions: [item.comment.id] })
  }, [ack])

  const focusKey = useCallback((key: string) => {
    setFocusedKey(key)
    const element = document.querySelector<HTMLElement>(`[data-inbox-key="${CSS.escape(key)}"] [data-inbox-item], [data-inbox-key="${CSS.escape(key)}"][data-inbox-item]`)
    element?.focus({ preventScroll: true })
    element?.scrollIntoView({ block: 'nearest' })
  }, [])

  // The first item is the tab stop until the person moves; an answered or acknowledged item leaves the list and focus moves to the one now in its place.
  useEffect(() => {
    if (ordered.length === 0) return
    const index = ordered.findIndex((item) => itemKey(item) === focusedKey)
    if (index !== -1) {
      lastIndex.current = index
      return
    }
    const next = ordered[Math.min(lastIndex.current, ordered.length - 1)]!
    if (focusedKey === null) setFocusedKey(itemKey(next))
    else focusKey(itemKey(next))
  }, [ordered, focusedKey, focusKey])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainShortcut(event) || event.shiftKey) return
      // Until focus is inside the list, J starts at the first item.
      const inList = document.activeElement instanceof Element && document.activeElement.closest('[data-inbox-key]') !== null
      const index = inList ? ordered.findIndex((item) => itemKey(item) === focusedKey) : -1
      const key = event.key
      if (key === 'j' || key === 'k' || key === 'ArrowDown' || key === 'ArrowUp') {
        if (ordered.length === 0) return
        event.preventDefault()
        const step = key === 'j' || key === 'ArrowDown' ? 1 : -1
        const next = ordered[index === -1 ? (step > 0 ? 0 : ordered.length - 1) : Math.min(Math.max(index + step, 0), ordered.length - 1)]!
        focusKey(itemKey(next))
        if (search.issue) browse(itemIssue(next))
      } else if ((key === 'o' || key === 'O') && index !== -1) {
        event.preventDefault()
        open(itemIssue(ordered[index]!))
      } else if ((key === 'e' || key === 'E') && index !== -1) {
        event.preventDefault()
        acknowledge(ordered[index]!)
      } else if (key === 'Escape' && search.issue) {
        event.preventDefault()
        close(search.issue)
        if (focusedKey) focusKey(focusedKey)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [ordered, focusedKey, focusKey, open, browse, close, acknowledge, search.issue])

  const section = (title: string, list: InboxItem[], action?: ReactNode) =>
    list.length === 0 ? null : (
      <section aria-label={title} className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-medium text-stone-500">
            {title} <span className="text-stone-400 tabular-nums">{list.length}</span>
          </h2>
          {action}
        </div>
        <ul className="space-y-2.5">
          {list.map((item) => {
            const key = itemKey(item)
            return (
              <li key={key} data-inbox-key={key} onFocusCapture={() => setFocusedKey(key)}>
                {item.kind === 'request' ? (
                  <RequestCard request={item.request} variant="inbox" focused={focusedKey === key} onOpen={() => open(item.request.issue)} />
                ) : (
                  <UpdateCard item={item} focused={focusedKey === key} onOpen={() => open(itemIssue(item))} onAck={() => acknowledge(item)} />
                )}
              </li>
            )
          })}
        </ul>
      </section>
    )

  return (
    <div className="relative flex h-full min-h-0">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <header className="flex h-12 items-center gap-2 border-b border-line bg-white px-4 sm:px-6">
          <Inbox aria-hidden className="size-4 text-stone-500" />
          <h1 className="text-[15px] font-semibold text-stone-900">{t('tracker.nav.inbox')}</h1>
          {inbox.data ? <span className="text-xs text-stone-400 tabular-nums">{t('tracker.inbox.count', { count: items.length })}</span> : null}
          <p className="ml-auto hidden text-[11px] text-stone-400 md:block">{t('tracker.inbox.keys')}</p>
        </header>
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-6 sm:px-6">
          {inbox.isPending ? (
            <Loading />
          ) : inbox.isError && !inbox.data ? (
            <LoadFailed error={inbox.error} onRetry={() => void inbox.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon={<CheckCheck />} title={t('tracker.inbox.emptyTitle')} body={t('tracker.inbox.emptyBody')} />
          ) : (
            <>
              {section(t('tracker.inbox.requests'), requests)}
              {section(
                t('tracker.inbox.updates'),
                updates,
                updates.length > 1 ? (
                  <Button
                    size="sm"
                    tone="ghost"
                    icon={<CheckCheck />}
                    className="ml-auto h-7 md:h-7"
                    onClick={() =>
                      ack.mutate({
                        answers: updates.flatMap((item) => (item.kind === 'answer' ? [item.request.id] : [])),
                        mentions: updates.flatMap((item) => (item.kind === 'mention' ? [item.comment.id] : [])),
                      })
                    }
                  >
                    {t('tracker.inbox.ackAll')}
                  </Button>
                ) : undefined
              )}
              {section(t('tracker.inbox.assignments'), assignments)}
            </>
          )}
        </div>
      </div>
      {panel.active ? <IssuePanel identifier={panel.active} panel={panel} /> : null}
    </div>
  )
}

/** An answer to the caller's question, a mention, or (for agents) an assignment. */
function UpdateCard({ item, focused, onOpen, onAck }: { item: Exclude<InboxItem, { kind: 'request' }>; focused: boolean; onOpen: () => void; onAck: () => void }) {
  const { t, locale } = useText()
  const issue = itemIssue(item)
  const at = item.kind === 'answer' ? item.request.answer!.at : item.kind === 'mention' ? item.comment.createdAt : item.issue.updatedAt
  const headline =
    item.kind === 'answer' ? t('tracker.inbox.answer', { name: item.request.answer!.by.name }) : item.kind === 'mention' ? t('tracker.inbox.mention', { name: item.comment.author.name }) : t('tracker.inbox.assignments')
  const actor = item.kind === 'answer' ? item.request.answer!.by : item.kind === 'mention' ? item.comment.author : null
  return (
    <article
      data-inbox-item
      tabIndex={focused ? 0 : -1}
      aria-label={`${headline}: ${issue.identifier} ${issue.title}`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) {
          event.preventDefault()
          onOpen()
        }
      }}
      className={cn('rounded-lg border border-line bg-white focus:outline-none', focused ? 'ring-2 ring-accent' : 'focus-visible:ring-2 focus-visible:ring-accent')}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 text-xs text-stone-500">
        {actor ? <ActorAvatar actor={actor} /> : null}
        <span className="font-medium text-stone-700">{headline}</span>
        <HrefLink
          href={paths.issue(issue.identifier)}
          className="min-w-0 truncate hover:text-stone-950 hover:underline"
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
            event.preventDefault()
            onOpen()
          }}
        >
          <span className="font-mono">{issue.identifier}</span> {issue.title}
        </HrefLink>
        <time dateTime={at} title={formatDateTime(at, locale)} className="ml-auto shrink-0">
          {formatRelative(at, locale)}
        </time>
      </header>
      <div className="space-y-2 px-4 pt-2 pb-3">
        {item.kind === 'answer' ? (
          <>
            <p className="text-[13px] font-medium text-stone-800">{item.request.title}</p>
            {item.request.answer!.option ? <p className="text-[13px] text-stone-800">{optionText(t, item.request.kind, item.request.answer!.option)}</p> : null}
            {item.request.answer!.body ? <Markdown source={item.request.answer!.body} className="text-[13px] leading-relaxed [&>*+*]:mt-2" /> : null}
            <p className="text-[11px]">
              <ActorName actor={item.request.answer!.by} />
            </p>
          </>
        ) : item.kind === 'mention' ? (
          <Markdown source={item.comment.body} className="line-clamp-4 text-[13px] leading-relaxed [&>*+*]:mt-2" />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {item.issue.activeRun ? <RunLine run={item.issue.activeRun} variant="row" /> : null}
            <OpenRequestMarker count={item.issue.openRequestCount} />
          </div>
        )}
        {item.kind !== 'assignment' ? (
          <div className="flex justify-end">
            <Button size="sm" tone="ghost" icon={<CheckCheck />} onClick={onAck}>
              {t('tracker.inbox.ack')}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  )
}
