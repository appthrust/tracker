// Bug report form and report fields wording.
import { defineDashboardMessages } from '@appthrust/platform-dashboard-i18n'

export const reportMessages = defineDashboardMessages({
  'tracker.report.lead': {
    defaultMessage: 'Where it happened, what you did and what you saw. Paste screenshots anywhere on this page.',
    translations: { ja: 'どこで、何をして、何が起きたか。スクリーンショットはこのページのどこでも貼り付けられます。' },
  },
  'tracker.report.section': { defaultMessage: 'Bug report', translations: { ja: '不具合報告' } },
  'tracker.report.edit': { defaultMessage: 'Edit', translations: { ja: '編集' } },
  'tracker.report.titleLabel': { defaultMessage: 'Summary', translations: { ja: '概要' } },
  'tracker.report.titlePlaceholder': { defaultMessage: 'e.g. Board loses filters after reload', translations: { ja: '例: 再読み込みするとボードの絞り込みが消える' } },
  'tracker.report.environment': { defaultMessage: 'Environment', translations: { ja: '環境' } },
  'tracker.report.environmentHint': { defaultMessage: 'Where you saw it', translations: { ja: '発生した場所' } },
  'tracker.report.surface': { defaultMessage: 'Surface', translations: { ja: '画面' } },
  'tracker.report.surfacePlaceholder': { defaultMessage: 'Choose…', translations: { ja: '選択…' } },
  'tracker.report.version': { defaultMessage: 'Version', translations: { ja: 'バージョン' } },
  'tracker.report.versionHint': { defaultMessage: 'From /releasez, if known', translations: { ja: '/releasez の値（分かれば）' } },
  'tracker.report.steps': { defaultMessage: 'Steps to reproduce', translations: { ja: '再現手順' } },
  'tracker.report.stepsHint': { defaultMessage: 'One step per line.', translations: { ja: '1 行に 1 手順。' } },
  'tracker.report.expected': { defaultMessage: 'Expected', translations: { ja: '期待した動作' } },
  'tracker.report.expectedHint': { defaultMessage: 'What should have happened.', translations: { ja: '本来どうなるべきか。' } },
  'tracker.report.actual': { defaultMessage: 'Actual', translations: { ja: '実際の動作' } },
  'tracker.report.actualHint': { defaultMessage: 'What happened instead, with any error text.', translations: { ja: '実際に起きたこと。エラー文もそのまま。' } },
  'tracker.report.screenshots': { defaultMessage: 'Screenshots', translations: { ja: 'スクリーンショット' } },
  'tracker.report.screenshotsHint': { defaultMessage: 'Paste with {mod}+V or drop files here', translations: { ja: '{mod}+V で貼り付け、またはここへドロップ' } },
  'tracker.report.chooseFile': { defaultMessage: 'Choose file', translations: { ja: 'ファイルを選ぶ' } },
  'tracker.report.submit': { defaultMessage: 'Report bug', translations: { ja: '報告する' } },
  'tracker.report.submitted': { defaultMessage: 'Reported {identifier}', translations: { ja: '{identifier} を報告しました' } },
  'tracker.report.seeReported': { defaultMessage: 'See everything I reported', translations: { ja: '自分が報告した課題を見る' } },
  'tracker.report.uploadFailedTitle': { defaultMessage: '{identifier} was created, but some screenshots were not attached', translations: { ja: '{identifier} を作成しましたが、一部のスクリーンショットを添付できませんでした' } },
  'tracker.report.uploadFailedBody': { defaultMessage: 'Not attached: {files}. Attach them again from the issue.', translations: { ja: '未添付: {files}。課題の画面からもう一度添付してください。' } },
})
