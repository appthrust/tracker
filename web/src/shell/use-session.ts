import { useSuspenseQuery } from '@tanstack/react-query'
import { meQuery } from '../api/queries'

/**
 * The signed-in author, their roles, Directory link and counts. The root route
 * loads `GET /me` before any page renders, so this never suspends there; the
 * live query keeps pages current after writes.
 */
export function useSession() {
  const { data: me } = useSuspenseQuery(meQuery)
  return { me }
}
