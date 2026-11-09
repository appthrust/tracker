import { AlertTriangle, CheckCircle2, Info, Loader2, RotateCw, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { isTrackerError } from '../api/tracker'
import type { MessageId } from '../copy'
import { useText } from '../i18n'
import { Button } from './button'
import { cn } from './cn'

export type NoticeTone = 'info' | 'success' | 'warning' | 'error'

const NOTICE: Record<NoticeTone, { box: string; icon: ReactNode }> = {
  info: { box: 'border-stone-200 bg-white text-stone-700', icon: <Info className="text-accent" /> },
  success: { box: 'border-accent-line bg-accent-soft text-accent-strong', icon: <CheckCircle2 /> },
  warning: { box: 'border-amber-200 bg-busy-soft text-busy-ink', icon: <AlertTriangle /> },
  error: { box: 'border-red-200 bg-bad-soft text-bad-ink', icon: <XCircle /> },
}

export function Notice({
  tone = 'info',
  title,
  children,
  actions,
  className,
}: {
  tone?: NoticeTone
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  const style = NOTICE[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0', style.box, className)}
    >
      {style.icon}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn(title ? 'mt-0.5 opacity-90' : undefined)}>{children}</div> : null}
        {actions ? <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}

export function EmptyState({ icon, title, body, action, heading = 'p' }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; heading?: 'p' | 'h1' }) {
  const Heading = heading
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-stone-300 bg-white px-6 py-12 text-center">
      {icon ? (
        <span aria-hidden className="mb-3 flex size-10 items-center justify-center rounded-full bg-stone-100 text-stone-500 [&_svg]:size-5">
          {icon}
        </span>
      ) : null}
      <Heading className={cn('font-medium text-stone-800', heading === 'h1' ? 'text-xl' : 'text-sm')}>{title}</Heading>
      {body ? <div className="mt-1 max-w-sm text-sm text-stone-500">{body}</div> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export function Loading({ className }: { className?: string }) {
  const { t } = useText()
  return (
    <p role="status" className={cn('flex items-center gap-2 py-6 text-sm text-stone-500', className)}>
      <Loader2 aria-hidden className="size-4 animate-spin text-accent" />
      {t('tracker.common.loading')}
    </p>
  )
}

/** A 401 cannot be fixed by retrying, so it gets the access-denied text and no retry button. */
export function LoadFailed({ error, onRetry }: { error?: unknown; onRetry: () => void }) {
  const { t } = useText()
  if (isTrackerError(error) && error.status === 401) return <Notice tone="error">{t('tracker.common.accessDenied')}</Notice>
  const known = errorMessageId(error)
  return (
    <Notice
      tone="error"
      title={t('tracker.common.loadFailed')}
      actions={
        <Button size="sm" icon={<RotateCw />} onClick={onRetry}>
          {t('tracker.common.retry')}
        </Button>
      }
    >
      {known ? t(known) : null}
    </Notice>
  )
}

/** The localized explanation for a known tracker error, else undefined. */
export function errorMessageId(error: unknown): MessageId | undefined {
  if (!isTrackerError(error)) return undefined
  if (error.transient) return 'tracker.errors.transient'
  if (error.status === 401) return 'tracker.common.accessDenied'
  if (error.code === 'tracker_store_unavailable') return 'tracker.errors.storeUnavailable'
  if (error.code === 'identity_unavailable') return 'tracker.errors.identityUnavailable'
  if (error.status === 403) return 'tracker.errors.forbidden'
  if (error.status === 404) return 'tracker.errors.notFound'
  if (error.status === 409) return 'tracker.errors.conflict'
  if (error.status === 400) return 'tracker.errors.invalid'
  return undefined
}

/** The server's own (not localized) reason for a 400/409, which the localized summary cannot name. */
export function errorDetail(error: unknown): string | undefined {
  if (!isTrackerError(error) || (error.status !== 400 && error.status !== 409)) return undefined
  return error.issues.length > 0 ? error.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join(' / ') : error.message
}

/** Failed mutation: the localized explanation first; the server's reason as a secondary hint for 400/409. */
export function ActionError({ error, className }: { error: unknown; className?: string }) {
  const { t } = useText()
  const known = errorMessageId(error)
  const detail = errorDetail(error)
  return (
    <Notice tone="error" title={known ? undefined : t('tracker.common.actionFailed')} className={className}>
      {known ? t(known) : null}
      {detail ? <span className="mt-0.5 block text-xs opacity-80">{detail}</span> : null}
    </Notice>
  )
}
