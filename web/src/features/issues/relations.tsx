// Parent, children and blocking links. Parent and "blocks" are this issue's
// own fields (PATCH parentId / blocks); adding a child sets the child's
// parentId; "blocked by" is the reverse of other issues' blocks and is shown
// read-only.
import { useQuery } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { issueSearchQuery } from '../../api/queries'
import type { Issue, IssueRef } from '../../api/tracker'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { HrefLink, Picker } from '../../ui'
import { useIssueEditor } from './properties'
import { useReference } from './use-reference'
import { StatusIcon } from './visuals'

/** Picks another issue by identifier or title words. */
export function IssueSearchPicker({ label, exclude, onPick, children }: { label: string; exclude: string[]; onPick: (issue: IssueRef) => void; children: ReactNode }) {
  const { t } = useText()
  const { statusById } = useReference()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const results = useQuery({ ...issueSearchQuery(query), enabled: open })
  const items = (results.data?.items ?? []).filter((issue) => !exclude.includes(issue.id))
  return (
    <Picker
      label={label}
      open={open}
      onOpenChange={setOpen}
      onQueryChange={setQuery}
      placeholder={t('tracker.relation.searchPlaceholder')}
      options={items.map((issue) => ({ value: issue.id, label: `${issue.identifier} ${issue.title}`, icon: <StatusIcon status={statusById.get(issue.statusId)} /> }))}
      selected={[]}
      onPick={(id) => {
        const issue = items.find((candidate) => candidate.id === id)
        if (issue) onPick({ id: issue.id, identifier: issue.identifier, title: issue.title, statusId: issue.statusId })
      }}
      empty={results.isFetching ? t('tracker.common.loading') : t('tracker.relation.noResults')}
    >
      {children}
    </Picker>
  )
}

function RefRow({ issue, onRemove, removeLabel }: { issue: IssueRef; onRemove?: () => void; removeLabel?: string }) {
  const { statusById } = useReference()
  return (
    <li className="group flex h-7 items-center gap-2 rounded px-1 text-[13px] hover:bg-stone-50">
      <StatusIcon status={statusById.get(issue.statusId)} />
      <HrefLink href={paths.issue(issue.identifier)} className="flex min-w-0 flex-1 items-center gap-2 hover:underline">
        <span className="shrink-0 font-mono text-xs text-stone-500">{issue.identifier}</span>
        <span className="truncate text-stone-800">{issue.title}</span>
      </HrefLink>
      {onRemove ? (
        <button type="button" aria-label={removeLabel} title={removeLabel} onClick={onRemove} className="rounded p-0.5 text-stone-400 opacity-0 group-hover:opacity-100 hover:text-stone-800 focus:opacity-100">
          <X aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </li>
  )
}

const ADD = 'inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-900'

export function Relations({ issue }: { issue: Issue }) {
  const { t } = useText()
  const { update } = useIssueEditor()
  const related = [issue.id, issue.parent?.id, ...issue.children.map((child) => child.id), ...issue.blocks.map((ref) => ref.id), ...issue.blockedBy.map((ref) => ref.id)].filter(
    (id): id is string => Boolean(id)
  )
  const group = (title: string, refs: IssueRef[], add: ReactNode, remove?: (ref: IssueRef) => void, removeLabel?: (ref: IssueRef) => string) => (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-stone-500">{title}</h3>
        {add}
      </div>
      {refs.length > 0 ? (
        <ul className="mt-1">
          {refs.map((ref) => (
            <RefRow key={ref.id} issue={ref} onRemove={remove ? () => remove(ref) : undefined} removeLabel={removeLabel?.(ref)} />
          ))}
        </ul>
      ) : null}
    </div>
  )
  return (
    <section aria-label={t('tracker.relation.title')} className="space-y-3">
      {group(
        t('tracker.relation.parent'),
        issue.parent ? [issue.parent] : [],
        <IssueSearchPicker label={t('tracker.relation.setParent')} exclude={[issue.id, ...issue.children.map((child) => child.id)]} onPick={(parent) => update({ id: issue.id, input: { parentId: parent.id } })}>
          <button type="button" className={ADD}>
            <Plus aria-hidden className="size-3" />
            {issue.parent ? t('tracker.relation.change') : t('tracker.relation.set')}
          </button>
        </IssueSearchPicker>,
        () => update({ id: issue.id, input: { parentId: null } }),
        (ref) => t('tracker.relation.removeParent', { identifier: ref.identifier })
      )}
      {group(
        t('tracker.relation.children'),
        issue.children,
        <IssueSearchPicker label={t('tracker.relation.addChild')} exclude={related} onPick={(child) => update({ id: child.id, input: { parentId: issue.id } })}>
          <button type="button" className={ADD}>
            <Plus aria-hidden className="size-3" />
            {t('tracker.relation.add')}
          </button>
        </IssueSearchPicker>,
        (child) => update({ id: child.id, input: { parentId: null } }),
        (ref) => t('tracker.relation.removeChild', { identifier: ref.identifier })
      )}
      {group(
        t('tracker.relation.blocks'),
        issue.blocks,
        <IssueSearchPicker label={t('tracker.relation.addBlocks')} exclude={related} onPick={(blocked) => update({ id: issue.id, input: { blocks: [...issue.blocks.map((ref) => ref.id), blocked.id] } })}>
          <button type="button" className={ADD}>
            <Plus aria-hidden className="size-3" />
            {t('tracker.relation.add')}
          </button>
        </IssueSearchPicker>,
        (blocked) => update({ id: issue.id, input: { blocks: issue.blocks.filter((ref) => ref.id !== blocked.id).map((ref) => ref.id) } }),
        (ref) => t('tracker.relation.removeBlocks', { identifier: ref.identifier })
      )}
      {issue.blockedBy.length > 0 ? group(t('tracker.relation.blockedBy'), issue.blockedBy, null) : null}
    </section>
  )
}
