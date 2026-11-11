// One request (question, approval, review), answerable in place: option
// buttons, Approve / Send back with an optional note, or free text. A review
// shows the finished run's report (Markdown) and links beside its decision.
// Keyboard, while the card has focus: 1–6 choose an option, Enter sends the
// chosen one (or, with nothing chosen, opens the issue), Esc clears the
// choice. The inbox, the issue's pinned requests and its timeline share it.
import { useQuery } from '@tanstack/react-query'
import { ClipboardCheck, ExternalLink, GitCommitHorizontal, GitPullRequest, Link2, MessageCircleQuestion, ShieldCheck, Undo2 } from 'lucide-react'
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { runQuery, useAnswerRequest, useWithdrawRequest } from '../../api/queries'
import type { Link, RequestKind, TrackerRequest } from '../../api/tracker'
import { useText, type Translate } from '../../i18n'
import { canAnswer, canWithdraw, DECISION_OPTIONS, isAgent } from '../../model/agents'
import { paths } from '../../routes/paths'
import { Button, cn, errorDetail, errorMessageId, formatDateTime, formatRelative, HrefLink, Kbd, Markdown, showToast, TextArea } from '../../ui'
import { isTypingTarget } from '../ui-state'
import { useReference } from '../issues/use-reference'
import { ActorAvatar } from './actor'

const KIND_ICON: Record<RequestKind, ReactNode> = {
  question: <MessageCircleQuestion aria-hidden />,
  approval: <ShieldCheck aria-hidden />,
  review: <ClipboardCheck aria-hidden />,
}

const LINK_ICON: Record<Link['kind'], ReactNode> = { pr: <GitPullRequest aria-hidden />, commit: <GitCommitHorizontal aria-hidden />, url: <Link2 aria-hidden /> }

export function KindBadge({ kind }: { kind: RequestKind }) {
  const { t } = useText()
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-busy-soft px-1.5 py-px text-[11px] font-medium text-busy-ink ring-1 ring-amber-200 ring-inset [&_svg]:size-3">
      {KIND_ICON[kind]}
      {t(`tracker.request.kind.${kind}`)}
    </span>
  )
}

/** A decision option in words: approve/reject read as the people's verbs, other options verbatim. */
export function optionText(t: Translate, kind: RequestKind, option: string): string {
  if (kind === 'question') return option
  return option === 'approve' ? t('tracker.request.option.approve') : option === 'reject' ? t('tracker.request.option.reject') : option
}

export function RunLinks({ links }: { links: Link[] }) {
  const { t } = useText()
  if (links.length === 0) return null
  return (
    <ul aria-label={t('tracker.run.links')} className="flex flex-wrap gap-1.5">
      {links.map((link) => (
        <li key={link.url}>
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-white px-2 py-1 text-xs text-stone-700 hover:border-stone-300 hover:text-stone-950 [&_svg]:size-3.5 [&_svg]:shrink-0"
          >
            {LINK_ICON[link.kind]}
            <span className="sr-only">{t(`tracker.link.${link.kind}`)}: </span>
            <span className="truncate">{link.title || link.url}</span>
            <ExternalLink aria-hidden className="text-stone-400" />
          </a>
        </li>
      ))}
    </ul>
  )
}

type Variant = 'inbox' | 'pinned' | 'timeline'

export function RequestCard({ request, variant, onOpen, focused = false }: { request: TrackerRequest; variant: Variant; onOpen?: () => void; focused?: boolean }) {
  const { t, locale } = useText()
  const { me, statuses } = useReference()
  const answer = useAnswerRequest()
  const withdraw = useWithdrawRequest()
  const [text, setText] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const textId = useId()
  const review = request.kind === 'review'
  const run = useQuery({ ...runQuery(request.runId ?? ''), enabled: review && request.runId !== null })
  const answerable = canAnswer(request, me)
  const decision = request.kind !== 'question'
  const options = decision ? DECISION_OPTIONS : request.options
  const done = statuses.find((status) => status.category === 'completed')
  const to = request.to === null ? t('tracker.request.anyPerson') : request.to.sub === me.sub ? t('tracker.request.you') : request.to.name

  const send = (option: string | null) => {
    if (answer.isPending) return
    const body = text.trim()
    if (option === null && !body) return
    answer.mutate(
      { id: request.id, input: { ...(option !== null ? { option } : {}), ...(body ? { body } : {}) }, idempotencyKey: crypto.randomUUID() },
      {
        onSuccess: () => {
          setText('')
          setChosen(null)
          const agentName = request.from.name
          showToast({
            tone: 'success',
            title: review && option === 'approve' ? t('tracker.request.completed', { identifier: request.issue.identifier }) : review && option === 'reject' ? t('tracker.request.sentBack', { identifier: request.issue.identifier, agent: agentName }) : t('tracker.request.sent'),
          })
        },
        onError: (error) => {
          const known = errorMessageId(error)
          showToast({ tone: 'error', title: t('tracker.request.failed'), detail: [known ? t(known) : undefined, errorDetail(error)].filter(Boolean).join(' ') || undefined })
        },
      }
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
    if (isTypingTarget(event.target)) {
      if (event.key === 'Escape') (event.target as HTMLElement).blur()
      return
    }
    if (answerable && /^[1-6]$/.test(event.key) && options[Number(event.key) - 1] !== undefined) {
      event.preventDefault()
      setChosen(options[Number(event.key) - 1]!)
    } else if (event.key === 'Enter' && event.target === event.currentTarget) {
      event.preventDefault()
      if (chosen !== null) send(chosen)
      else onOpen?.()
    } else if (event.key === 'Escape' && chosen !== null) {
      event.preventDefault()
      event.stopPropagation()
      setChosen(null)
    }
  }

  const summary = review ? (run.data?.summary ?? request.body) : request.body
  return (
    <article
      data-inbox-item={variant === 'inbox' ? request.id : undefined}
      tabIndex={variant === 'inbox' ? (focused ? 0 : -1) : 0}
      aria-label={t('tracker.inbox.item', { kind: t(`tracker.request.kind.${request.kind}`), title: request.title, identifier: request.issue.identifier })}
      onKeyDown={onKeyDown}
      className={cn(
        'rounded-lg border bg-white focus:outline-none',
        request.state === 'open' ? 'border-amber-200' : 'border-line',
        focused ? 'ring-2 ring-accent' : 'focus-visible:ring-2 focus-visible:ring-accent',
        variant === 'pinned' && 'shadow-xs'
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 text-xs text-stone-500">
        <KindBadge kind={request.kind} />
        {variant === 'inbox' ? (
          <HrefLink href={paths.issue(request.issue.identifier)} className="min-w-0 truncate font-medium text-stone-700 hover:text-stone-950 hover:underline" onClick={(event) => {
            if (!onOpen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
            event.preventDefault()
            onOpen()
          }}>
            <span className="font-mono">{request.issue.identifier}</span> {request.issue.title}
          </HrefLink>
        ) : null}
        <span className="flex min-w-0 items-center gap-1.5">
          <ActorAvatar actor={request.from} />
          <span className="truncate">{t('tracker.request.fromTo', { from: request.from.name, to })}</span>
        </span>
        <time dateTime={request.createdAt} title={formatDateTime(request.createdAt, locale)} className="ml-auto shrink-0">
          {formatRelative(request.createdAt, locale)}
        </time>
      </header>
      <div className="space-y-3 px-4 pt-2 pb-4">
        <h3 className="text-[14px] leading-snug font-semibold text-stone-900">{request.title}</h3>
        {isAgent(request.from) && variant !== 'timeline' ? <p className="-mt-2 text-[11px] text-stone-500">{t('tracker.agent.ownedBy', { name: request.from.agent.owner.name })}</p> : null}
        {summary ? (
          <div className={cn(review && 'rounded-md border border-line bg-stone-50/70 px-3 py-2.5')}>
            {review ? <p className="mb-1 text-[11px] font-medium text-stone-500">{t('tracker.run.summary')}</p> : null}
            <Markdown source={summary} className="text-[13px] leading-relaxed [&>*+*]:mt-2" />
          </div>
        ) : null}
        {review && run.data ? <RunLinks links={run.data.links} /> : null}

        {request.state === 'answered' && request.answer ? (
          <div className="rounded-md bg-stone-50 px-3 py-2 text-[13px]">
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-stone-500">
              <ActorAvatar actor={request.answer.by} />
              {t('tracker.request.answeredBy', { name: request.answer.by.name, time: formatRelative(request.answer.at, locale) })}
              {request.answer.option ? <span className="rounded bg-white px-1.5 py-px font-medium text-stone-800 ring-1 ring-line">{optionText(t, request.kind, request.answer.option)}</span> : null}
            </p>
            {request.answer.body ? <Markdown source={request.answer.body} className="mt-1.5 text-[13px] leading-relaxed [&>*+*]:mt-2" /> : null}
          </div>
        ) : request.state === 'withdrawn' ? (
          <p className="text-xs text-stone-500">{t('tracker.request.withdrawn')}</p>
        ) : answerable ? (
          <div className="space-y-2.5">
            {review && done ? <p className="text-xs text-stone-500">{t('tracker.request.reviewHint', { identifier: request.issue.identifier, status: done.name, agent: request.from.name })}</p> : null}
            {options.length > 0 ? (
              <div role="group" aria-label={t('tracker.request.reply')} className="flex flex-wrap gap-1.5">
                {options.map((option, index) => (
                  <Button
                    key={option}
                    size="sm"
                    tone={decision ? (option === 'approve' ? 'primary' : 'secondary') : 'secondary'}
                    aria-pressed={chosen === option}
                    loading={answer.isPending && answer.variables?.input.option === option}
                    onClick={() => send(option)}
                    className={cn('max-w-full', chosen === option && 'ring-2 ring-accent ring-offset-1')}
                    icon={decision ? option === 'approve' ? <ShieldCheck /> : <Undo2 /> : undefined}
                  >
                    {index < 6 ? <Kbd className={cn(decision && option === 'approve' && 'border-white/30 bg-white/15 text-white')}>{String(index + 1)}</Kbd> : null}
                    <span className="truncate">{decision ? (option === 'approve' ? t('tracker.request.approve') : t('tracker.request.reject')) : option}</span>
                  </Button>
                ))}
              </div>
            ) : null}
            <div>
              <label htmlFor={textId} className="sr-only">
                {t('tracker.request.reply')}
              </label>
              <TextArea
                id={textId}
                rows={2}
                value={text}
                placeholder={decision || options.length > 0 ? t('tracker.request.notePlaceholder') : t('tracker.request.replyPlaceholder')}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    send(chosen)
                  }
                }}
                className="min-h-0 text-[13px]"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <p aria-live="polite" className="mr-auto text-[11px] text-stone-500">
                {chosen !== null ? t('tracker.request.chosen', { option: optionText(t, request.kind, chosen) }) : options.length > 0 ? t('tracker.request.chooseHint', { count: Math.min(options.length, 6) }) : null}
              </p>
              {!decision ? (
                <Button size="sm" tone={options.length === 0 ? 'primary' : 'secondary'} disabled={!text.trim() && chosen === null} loading={answer.isPending && answer.variables?.input.option === undefined} onClick={() => send(chosen)}>
                  {t('tracker.request.send')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-xs text-stone-500">{request.to ? t('tracker.request.waitingFor', { name: request.to.name }) : decision ? t('tracker.request.peopleOnly') : t('tracker.request.open')}</p>
        )}
        {canWithdraw(request, me) ? (
          <Button size="sm" tone="ghost" icon={<Undo2 />} loading={withdraw.isPending} onClick={() => withdraw.mutate(request.id)}>
            {t('tracker.request.withdraw')}
          </Button>
        ) : null}
      </div>
    </article>
  )
}
