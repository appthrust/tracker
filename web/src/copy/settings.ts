// Workspace, status and label settings wording.
import { defineDashboardMessages } from '@appthrust/platform-dashboard-i18n'

export const settingsMessages = defineDashboardMessages({
  'tracker.settings.workspace': { defaultMessage: 'Workspace', translations: { ja: 'ワークスペース' } },
  'tracker.settings.statuses': { defaultMessage: 'Statuses', translations: { ja: '状態' } },
  'tracker.settings.readOnlyTitle': { defaultMessage: 'Read-only', translations: { ja: '閲覧のみ' } },
  'tracker.settings.readOnlyBody': { defaultMessage: 'Only Project Team admins can change these settings.', translations: { ja: 'これらの設定を変更できるのはプロジェクトチームの管理者だけです。' } },
  'tracker.settings.key': { defaultMessage: 'Issue key', translations: { ja: '課題キー' } },
  'tracker.settings.keyHint': { defaultMessage: 'Prefix of every identifier, like {example}. Numbers never change.', translations: { ja: '識別子の接頭辞（例: {example}）。番号は変わりません。' } },
  'tracker.settings.keyInvalid': { defaultMessage: 'Use 2–6 capital letters or digits, starting with a letter.', translations: { ja: '英大文字で始まる 2〜6 文字の英大文字・数字にしてください。' } },
  'tracker.settings.nameInvalid': { defaultMessage: 'Use 1–100 characters.', translations: { ja: '1〜100 文字で入力してください。' } },
  'tracker.settings.issueCount': { defaultMessage: '{count} issues in this workspace', translations: { ja: 'このワークスペースの課題: {count} 件' } },
  'tracker.settings.saved': { defaultMessage: 'Saved.', translations: { ja: '保存しました。' } },
  'tracker.settings.statusName': { defaultMessage: 'Status name', translations: { ja: '状態の名前' } },
  'tracker.settings.labelName': { defaultMessage: 'Label name', translations: { ja: 'ラベルの名前' } },
  'tracker.settings.color': { defaultMessage: 'Color of {name}', translations: { ja: '{name} の色' } },
  'tracker.settings.newColor': { defaultMessage: 'Color', translations: { ja: '色' } },
  'tracker.settings.moveUp': { defaultMessage: 'Move {name} up', translations: { ja: '{name} を上へ' } },
  'tracker.settings.moveDown': { defaultMessage: 'Move {name} down', translations: { ja: '{name} を下へ' } },
  'tracker.settings.addStatus': { defaultMessage: 'New status name', translations: { ja: '新しい状態の名前' } },
  'tracker.settings.addLabel': { defaultMessage: 'New label name', translations: { ja: '新しいラベルの名前' } },
  'tracker.settings.deleteStatus': { defaultMessage: 'Delete status {name}', translations: { ja: '状態 {name} を削除' } },
  'tracker.settings.deleteStatusTitle': { defaultMessage: 'Delete status “{name}”?', translations: { ja: '状態「{name}」を削除しますか？' } },
  'tracker.settings.deleteStatusBody': {
    defaultMessage: 'Only an unused status can be deleted; move its issues first. Each category keeps at least one status.',
    translations: { ja: '使われていない状態だけ削除できます。先に課題を移してください。各カテゴリには 1 つ以上の状態が必要です。' },
  },
  'tracker.settings.deleteLabel': { defaultMessage: 'Delete label {name}', translations: { ja: 'ラベル {name} を削除' } },
  'tracker.settings.deleteLabelTitle': { defaultMessage: 'Delete label “{name}”?', translations: { ja: 'ラベル「{name}」を削除しますか？' } },
  'tracker.settings.deleteLabelBody': { defaultMessage: 'It is removed from every issue.', translations: { ja: 'すべての課題から外れます。' } },
  'tracker.settings.noLabels': { defaultMessage: 'No labels yet.', translations: { ja: 'ラベルはまだありません。' } },
})
