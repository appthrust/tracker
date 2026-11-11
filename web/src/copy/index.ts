// All tracker wording, as dashboard-i18n catalogs: the English source is the
// `defaultMessage`, Japanese (the audience's default) is `translations.ja`.
// Screens read it through `useText().t(id, values)` (src/i18n.tsx); no screen
// hardcodes user-facing text.
import type { DashboardMessageCatalog } from '@appthrust/platform-dashboard-i18n'
import { commonMessages } from './common'
import { epicMessages } from './epics'
import { issueMessages } from './issues'
import { projectMessages } from './projects'
import { reportMessages } from './report'
import { settingsMessages } from './settings'
import { sprintMessages } from './sprints'

export const catalogs: readonly DashboardMessageCatalog[] = [commonMessages, issueMessages, epicMessages, projectMessages, reportMessages, settingsMessages, sprintMessages]

export type MessageId =
  | keyof typeof commonMessages
  | keyof typeof issueMessages
  | keyof typeof epicMessages
  | keyof typeof projectMessages
  | keyof typeof reportMessages
  | keyof typeof settingsMessages
  | keyof typeof sprintMessages
