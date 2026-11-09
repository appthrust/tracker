import { useSuspenseQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { labelsQuery, meQuery, statusesQuery, viewsQuery, workspaceQuery } from '../../api/queries'
import type { Label, Status } from '../../api/tracker'
import { orderStatuses } from '../../model/issues'

/**
 * The caller, workspace, statuses (category order), labels and views. The root
 * route loads them before any page renders, so this never suspends there; the
 * live queries keep pages current after writes and every 15 s.
 */
export function useReference() {
  const { data: me } = useSuspenseQuery(meQuery)
  const { data: workspace } = useSuspenseQuery(workspaceQuery)
  const { data: rawStatuses } = useSuspenseQuery(statusesQuery)
  const { data: labels } = useSuspenseQuery(labelsQuery)
  const { data: views } = useSuspenseQuery(viewsQuery)
  return useMemo(() => {
    const statuses = orderStatuses(rawStatuses)
    const statusById = new Map<string, Status>(statuses.map((status) => [status.id, status]))
    const labelById = new Map<string, Label>(labels.map((label) => [label.id, label]))
    return { me, workspace, statuses, labels, views, statusById, labelById }
  }, [me, workspace, rawStatuses, labels, views])
}
