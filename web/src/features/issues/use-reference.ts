import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { agentsQuery, labelsQuery, meQuery, projectsQuery, statusesQuery, viewsQuery, workspaceQuery } from '../../api/queries'
import type { Agent, Label, Project, Status } from '../../api/tracker'
import { orderStatuses } from '../../model/issues'

const NO_PROJECTS: Project[] = []
const NO_AGENTS: Agent[] = []

/**
 * The caller, workspace, statuses (category order), labels, views,
 * projects and agents. The root route loads them before any page renders, so
 * this never suspends there; the live queries keep pages current after writes
 * and every 15 s. Projects and agents are optional reference data (the root
 * only prefetches them): until they load, or if they fail, every screen works
 * as if there were none. `projects` includes archived ones (names for issues
 * that keep them); `activeProjects` is what pickers and the sidebar offer.
 * Likewise `agents` includes disabled ones and `activeAgents` is what the
 * assignee picker and mentions offer.
 */
export function useReference() {
  const { data: me } = useSuspenseQuery(meQuery)
  const { data: workspace } = useSuspenseQuery(workspaceQuery)
  const { data: rawStatuses } = useSuspenseQuery(statusesQuery)
  const { data: labels } = useSuspenseQuery(labelsQuery)
  const { data: views } = useSuspenseQuery(viewsQuery)
  const { data: projects = NO_PROJECTS } = useQuery(projectsQuery)
  const { data: agents = NO_AGENTS } = useQuery(agentsQuery)
  return useMemo(() => {
    const statuses = orderStatuses(rawStatuses)
    const statusById = new Map<string, Status>(statuses.map((status) => [status.id, status]))
    const labelById = new Map<string, Label>(labels.map((label) => [label.id, label]))
    const sortedProjects = [...projects].sort((a, b) => a.name.localeCompare(b.name))
    const activeProjects = sortedProjects.filter((project) => !project.archived)
    const projectById = new Map<string, Project>(sortedProjects.map((project) => [project.id, project]))
    const sortedAgents = [...agents].sort((a, b) => a.name.localeCompare(b.name))
    const activeAgents = sortedAgents.filter((agent) => !agent.disabled)
    return { me, workspace, statuses, labels, views, statusById, labelById, projects: sortedProjects, activeProjects, projectById, agents: sortedAgents, activeAgents }
  }, [me, workspace, rawStatuses, labels, views, projects, agents])
}
