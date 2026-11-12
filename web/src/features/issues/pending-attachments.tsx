// Files chosen before their issue exists (the bug report page, the New issue
// dialog): picked, pasted or dropped, checked against the API limits as they
// arrive (a refusal says why, next to the area), previewed until removed, and
// sent one by one once the issue is created. A preview's object URL is revoked
// when the file is removed and when the form goes away.
import { FileText, ImagePlus, X } from 'lucide-react'
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { trackerApi } from '../../api/tracker'
import { useText, type Translate } from '../../i18n'
import { acceptAttachments, ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, ATTACHMENTS_PER_ISSUE, attachmentTypeNames, isImage, uploadInOrder } from '../../model/issues'
import { Button, cn } from '../../ui'
import { problemText, transferFiles } from './attachments'

export type PendingFile = { id: number; file: File; preview: string | null }

/** Files waiting for their issue, and what to do with them. */
export type PendingAttachments = {
  files: PendingFile[]
  /** Why the last offered files that did not fit were refused (one line per reason). */
  refusals: string[]
  /** The file being sent (1-based) while uploading, else null. */
  progress: { current: number; total: number } | null
  uploading: boolean
  /** No room for another file on the issue. */
  full: boolean
  add: (offered: File[]) => void
  remove: (id: number) => void
  onPaste: (event: ClipboardEvent) => void
  onDrop: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  upload: (issueId: string) => Promise<string[]>
}

export function usePendingAttachments(): PendingAttachments {
  const { t } = useText()
  const [files, setFiles] = useState<PendingFile[]>([])
  const [refusals, setRefusals] = useState<string[]>([])
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  // The current list for work that outlives a render: the upload after `await create`, the unmount cleanup.
  const latest = useRef<PendingFile[]>([])
  const nextId = useRef(0)
  useEffect(() => () => latest.current.forEach((pending) => pending.preview && URL.revokeObjectURL(pending.preview)), [])

  const uploading = progress !== null
  const replace = (next: PendingFile[]) => {
    latest.current = next
    setFiles(next)
  }

  /** Adds what fits; the reasons for the rest replace the previous ones. */
  const add = (offered: File[]) => {
    if (uploading) return
    const { accepted, refused } = acceptAttachments(offered, latest.current.length)
    setRefusals([...new Set(refused.map(({ file, problem }) => problemText(t, problem, file)))])
    if (accepted.length === 0) return
    replace([...latest.current, ...accepted.map((file) => ({ id: nextId.current++, file, preview: isImage(file.type) ? URL.createObjectURL(file) : null }))])
  }
  const remove = (id: number) => {
    const preview = latest.current.find((pending) => pending.id === id)?.preview
    if (preview) URL.revokeObjectURL(preview)
    replace(latest.current.filter((pending) => pending.id !== id))
  }
  /** Screenshots on the clipboard become files here instead of text; a plain-text paste is left alone. */
  const onPaste = (event: ClipboardEvent) => {
    const offered = transferFiles(event.clipboardData)
    if (offered.length === 0) return
    event.preventDefault()
    add(offered)
  }
  const onDrop = (event: DragEvent) => {
    const offered = transferFiles(event.dataTransfer)
    if (offered.length === 0) return
    event.preventDefault()
    add(offered)
  }
  /** Accepts dragged files; dragged text keeps the browser's behaviour. */
  const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault()
  }
  /** Sends every chosen file to the created issue, in order; returns the names that were not attached. */
  const upload = async (issueId: string): Promise<string[]> => {
    const queue = latest.current.map((pending) => pending.file)
    if (queue.length === 0) return []
    setProgress({ current: 1, total: queue.length })
    try {
      const failed = await uploadInOrder(queue, (file) => trackerApi.issues.attach(issueId, file), (index) => setProgress({ current: index + 1, total: queue.length }))
      return failed.map((file) => file.name)
    } finally {
      setProgress(null)
    }
  }

  return { files, refusals, progress, uploading, full: files.length >= ATTACHMENTS_PER_ISSUE, add, remove, onPaste, onDrop, onDragOver, upload }
}

/** The limits in words, from the API constants: types, size per file, files per issue. */
export function limitsText(t: Translate, locale: string): string {
  return t('tracker.attachment.limits', {
    types: new Intl.ListFormat(locale, { type: 'disjunction' }).format(attachmentTypeNames()),
    size: ATTACHMENT_MAX_BYTES / (1024 * 1024),
    max: ATTACHMENTS_PER_ISSUE,
  })
}

/** The file picker: several at once, only the accepted types; off while full or uploading. */
export function ChooseFilesButton({ pending, label, disabled }: { pending: PendingAttachments; label: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button size="sm" icon={<ImagePlus />} onClick={() => input.current?.click()} disabled={disabled || pending.full || pending.uploading}>
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ATTACHMENT_TYPES.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          pending.add([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
    </>
  )
}

/** A preview per chosen file (image, else a file glyph) with its name and a remove button; nothing while none are chosen. */
export function PendingPreviews({ pending, className }: { pending: PendingAttachments; className?: string }) {
  const { t } = useText()
  if (pending.files.length === 0) return null
  return (
    <ul className={cn('grid grid-cols-2 gap-2 sm:grid-cols-4', className)}>
      {pending.files.map(({ id, file, preview }) => (
        <li key={id} className="relative overflow-hidden rounded-md border border-line">
          {preview ? (
            <img src={preview} alt={file.name} className="aspect-video w-full bg-stone-50 object-contain" />
          ) : (
            <span className="flex aspect-video items-center justify-center bg-stone-50 text-stone-400">
              <FileText aria-hidden className="size-6" />
            </span>
          )}
          <span className="block truncate border-t border-line px-2 py-1 text-[11px] text-stone-600" title={file.name}>
            {file.name}
          </span>
          <button
            type="button"
            aria-label={t('tracker.attachment.delete', { name: file.name })}
            title={t('tracker.attachment.delete', { name: file.name })}
            disabled={pending.uploading}
            onClick={() => pending.remove(id)}
            className="absolute top-1 right-1 flex size-6 items-center justify-center rounded bg-white/90 text-stone-500 shadow-sm hover:text-bad-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-stone-500"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Why offered files were not added, announced when they appear. */
export function PendingRefusals({ pending, className }: { pending: PendingAttachments; className?: string }) {
  if (pending.refusals.length === 0) return null
  return (
    <div role="alert" className={cn('text-xs text-bad-ink', className)}>
      {pending.refusals.map((text) => (
        <p key={text}>{text}</p>
      ))}
    </div>
  )
}
