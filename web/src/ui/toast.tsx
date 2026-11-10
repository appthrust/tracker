// Transient messages for background writes that have no form to show an error
// in (an optimistic status change that the server refused, an upload), or a
// done write with a next step (`action`: a link). One polite live region; each
// message disappears after a few seconds, a little later when it has a link.
import { Store, useSelector } from '@tanstack/react-store'
import { CheckCircle2, X, XCircle } from 'lucide-react'
import { useText } from '../i18n'
import { cn } from './cn'
import { HrefLink } from './link'

type Toast = { id: number; tone: 'error' | 'success'; title: string; detail?: string; action?: { label: string; href: string } }

const toastStore = new Store<{ toasts: Toast[] }>({ toasts: [] })
let nextToastId = 1
const TOAST_MS = 6_000
const TOAST_WITH_ACTION_MS = 12_000

export function dismissToast(id: number) {
  toastStore.setState((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
}

export function showToast(toast: Omit<Toast, 'id'>) {
  const id = nextToastId++
  toastStore.setState((state) => ({ toasts: [...state.toasts.slice(-2), { ...toast, id }] }))
  setTimeout(() => dismissToast(id), toast.action ? TOAST_WITH_ACTION_MS : TOAST_MS)
}

export function Toaster() {
  const { t } = useText()
  const toasts = useSelector(toastStore, (state) => state.toasts)
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-white px-3 py-2.5 text-[13px] shadow-lg animate-pop-in [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
            toast.tone === 'error' ? 'border-red-200 text-bad-ink' : 'border-line text-stone-700'
          )}
        >
          {toast.tone === 'error' ? <XCircle aria-hidden /> : <CheckCircle2 aria-hidden className="text-accent" />}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{toast.title}</p>
            {toast.detail ? <p className="mt-0.5 text-xs opacity-80">{toast.detail}</p> : null}
            {toast.action ? (
              <HrefLink href={toast.action.href} onClick={() => dismissToast(toast.id)} className="mt-1 inline-block text-xs font-medium text-accent-strong underline underline-offset-2 hover:text-accent">
                {toast.action.label}
              </HrefLink>
            ) : null}
          </div>
          <button type="button" aria-label={t('tracker.common.close')} onClick={() => dismissToast(toast.id)} className="-m-1 rounded p-1 text-stone-400 hover:text-stone-700">
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
