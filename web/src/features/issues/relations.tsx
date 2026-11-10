// Children and blocking links of a work item. "Blocks" is this issue's own
// field (PATCH blocks); adding a child sets the child's parentId; "blocked
// by" is the reverse of other issues' blocks and is shown read-only. The
// parent is a property (hierarchy.tsx `IssueParentPicker`); an epic's or
// story's children are its hierarchy section.
import { useQuery } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { issueSearchQuery } from '../../api/queries'
import type { Issue, IssueRef, IssueSummary } from '../../api/tracker'
import { useText } from '../../i18n'
import { canParent, levelOf } from '../../model/issues'
import { paths } from '../../routes/paths'
import { HrefLink, Picker } from '../../ui'
import { useIssueEditor } from './properties'
import { useReference } from './use-reference'
import { StatusIcon, TypeIcon } from './visuals'

/** Picks another issue by identifier or title words; `accept` hides results that cannot be picked here (hierarchy rules). */
export function IssueSearchPicker({
  label,
  exclude,
  accept,
  onPick,
  children,
}: {
  label: string
  exclude: string[]
  accept?: (issue: IssueSummary) => boolean
  onPick: (issue: IssueSummary) => void
  children: ReactNode
}) {
  const { t } = useText()
  const { statusById } = useReference()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const results = useQuery({ ...issueSearchQuery(query), enabled: open })
  const items = (results.data?.items ?? []).filter((issue) => !exclude.includes(issue.id) && (accept?.(issue) ?? true))
  return (
    <Picker
      label={label}
      open={open}
      onOpenChange={setOpen}
      onQueryChange={setQuery}
      placeholder={t('tracker.relation.searchPlaceholder')}
      options={items.map((issue) => ({
        value: issue.id,
        label: `${issue.identifier} ${issue.title}`,
        icon: levelOf(issue.type) > 0 ? <TypeIcon type={issue.type} /> : <StatusIcon status={statusById.get(issue.statusId)} />,
      }))}
      selected={[]}
      onPick={(id) => {
        const issue = items.find((candidate) => candidate.id === id)
        if (issue) onPick(issue)
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
      {levelOf(issue.type) === 0
        ? group(
            t('tracker.relation.children'),
            issue.children,
            <IssueSearchPicker
              label={t('tracker.relation.addChild')}
              exclude={related}
              accept={(candidate) => canParent(candidate.type, issue.type)}
              onPick={(child) => update({ id: child.id, input: { parentId: issue.id }, parent: issue })}
            >
              <button type="button" className={ADD}>
                <Plus aria-hidden className="size-3" />
                {t('tracker.relation.add')}
              </button>
            </IssueSearchPicker>,
            (child) => update({ id: child.id, input: { parentId: null } }),
            (ref) => t('tracker.relation.removeChild', { identifier: ref.identifier })
          )
        : null}
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
