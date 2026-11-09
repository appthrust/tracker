// Attachments: pasted or dropped screenshots and small text/JSON files
// (API.md: ≤ 2 MiB, ≤ 10 per issue, png/jpeg/webp/text/json). Images preview
// inline; every file opens from its same-origin URL.
import { FileText, ImagePlus, Trash2 } from 'lucide-react'
import { useRef, type ClipboardEvent, type DragEvent } from 'react'
import { useAttach, useDeleteAttachment } from '../../api/queries'
import type { Attachment } from '../../api/tracker'
import { useText, type Translate } from '../../i18n'
import { ATTACHMENT_TYPES, ATTACHMENTS_PER_ISSUE, attachmentProblem, isImage } from '../../model/issues'
import { Button, errorDetail, errorMessageId, showToast } from '../../ui'
import { useReference } from './use-reference'

/** Clipboard images arrive as "image.png"; give them a findable, unique name. */
export function namedFile(file: File, now = new Date()): File {
  if (file.name && file.name !== 'image.png' && file.name !== 'image.jpeg') return file
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const extension = file.type.split('/')[1] ?? 'png'
  return new File([file], `screenshot-${stamp}.${extension}`, { type: file.type })
}

/** Files on a paste (screenshots) or drop. */
export function transferFiles(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  const files = [...transfer.files]
  if (files.length > 0) return files.map((file) => namedFile(file))
  return [...transfer.items].filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => file !== null).map((file) => namedFile(file))
}

export function problemText(t: Translate, problem: 'tooLarge' | 'type' | 'tooMany', file: { name: string }) {
  if (problem === 'tooMany') return t('tracker.attachment.tooMany', { max: ATTACHMENTS_PER_ISSUE })
  if (problem === 'type') return t('tracker.attachment.badType', { name: file.name })
  return t('tracker.attachment.tooLarge', { name: file.name })
}

/** Uploads files one by one, refusing what the server would refuse; returns what was attached. */
export function useUploader(issueId: string, existing: number) {
  const { t } = useText()
  const attach = useAttach(issueId)
  const upload = async (files: File[]): Promise<Attachment[]> => {
    const done: Attachment[] = []
    for (const file of files) {
      const problem = attachmentProblem(file, existing + done.length)
      if (problem) {
        showToast({ tone: 'error', title: t('tracker.attachment.failed'), detail: problemText(t, problem, file) })
        continue
      }
      try {
        done.push(await attach.mutateAsync(file))
      } catch (error) {
        const known = errorMessageId(error)
        showToast({ tone: 'error', title: t('tracker.attachment.failed'), detail: [file.name, known ? t(known) : undefined, errorDetail(error)].filter(Boolean).join(' — ') })
      }
    }
    return done
  }
  return { upload, pending: attach.isPending }
}

export const markdownFor = (attachment: Attachment) =>
  isImage(attachment.mediaType) ? `![${attachment.filename}](${attachment.url})` : `[${attachment.filename}](${attachment.url})`

export function Attachments({ issueId, attachments }: { issueId: string; attachments: Attachment[] }) {
  const { t, locale } = useText()
  const { me } = useReference()
  const input = useRef<HTMLInputElement>(null)
  const { upload, pending } = useUploader(issueId, attachments.length)
  const remove = useDeleteAttachment(issueId)
  const onDrop = (event: DragEvent) => {
    const files = transferFiles(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    void upload(files)
  }
  const onPaste = (event: ClipboardEvent) => {
    const files = transferFiles(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    void upload(files)
  }
  return (
    <section aria-labelledby={`attachments-${issueId}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop} onPaste={onPaste}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id={`attachments-${issueId}`} className="text-xs font-medium text-stone-500">
          {t('tracker.attachment.title')} <span className="tabular-nums">{attachments.length > 0 ? attachments.length : ''}</span>
        </h2>
        <Button size="sm" tone="ghost" icon={<ImagePlus />} loading={pending} onClick={() => input.current?.click()} disabled={attachments.length >= ATTACHMENTS_PER_ISSUE}>
          {t('tracker.attachment.add')}
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
            void upload([...(event.target.files ?? [])])
            event.target.value = ''
          }}
        />
      </div>
      {attachments.length === 0 ? (
        <p className="rounded-md border border-dashed border-stone-300 px-3 py-4 text-center text-xs text-stone-500">{t('tracker.attachment.empty')}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="group relative overflow-hidden rounded-md border border-line bg-white">
              <a href={attachment.url} target="_blank" rel="noopener noreferrer" className="block" title={attachment.filename}>
                {isImage(attachment.mediaType) ? (
                  <img src={attachment.url} alt={attachment.filename} loading="lazy" className="aspect-video w-full bg-stone-50 object-contain" />
                ) : (
                  <span className="flex aspect-video items-center justify-center bg-stone-50 text-stone-400">
                    <FileText aria-hidden className="size-6" />
                  </span>
                )}
                <span className="block truncate border-t border-line px-2 py-1 text-[11px] text-stone-600">
                  {attachment.filename} · {new Intl.NumberFormat(locale, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 }).format(Math.max(1, attachment.size / 1024))}
                </span>
              </a>
              {attachment.uploader.sub === me.sub || me.isAdmin ? (
                <button
                  type="button"
                  aria-label={t('tracker.attachment.delete', { name: attachment.filename })}
                  title={t('tracker.attachment.delete', { name: attachment.filename })}
                  onClick={() => remove.mutate(attachment.id)}
                  className="absolute top-1 right-1 flex size-7 items-center justify-center rounded bg-white/90 text-stone-500 opacity-0 shadow-sm group-hover:opacity-100 hover:text-bad-ink focus:opacity-100"
                >
                  <Trash2 aria-hidden className="size-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
