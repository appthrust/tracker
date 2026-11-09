import { useReference } from '../features/issues/use-reference'

/**
 * The signed-in person (role from the Project Team), the workspace and the
 * saved views. The root route loads them before any page renders, so this
 * never suspends there; the live queries keep the shell current.
 */
export function useSession() {
  const { me, workspace, views } = useReference()
  return { me, workspace, views }
}
