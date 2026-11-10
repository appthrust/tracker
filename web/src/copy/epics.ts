// Epics and stories wording: the two types, grouping lists and boards, the
// hierarchy rules, the parent picker, the epic/story child list, the epics
// overview (`/epics`) and the palette's bundling commands.
import { defineDashboardMessages } from '@appthrust/platform-dashboard-i18n'

export const epicMessages = defineDashboardMessages({
  'tracker.type.epic': { defaultMessage: 'Epic', translations: { ja: 'エピック' } },
  'tracker.type.story': { defaultMessage: 'Story', translations: { ja: 'ストーリー' } },
  'tracker.type.notAllowed': { defaultMessage: 'Not allowed here', translations: { ja: 'ここでは選べません' } },

  'tracker.group.label': { defaultMessage: 'Group', translations: { ja: 'グループ' } },
  'tracker.group.none': { defaultMessage: 'No grouping', translations: { ja: 'グループなし' } },
  'tracker.group.epic': { defaultMessage: 'By epic', translations: { ja: 'エピック別' } },
  'tracker.group.story': { defaultMessage: 'By story', translations: { ja: 'ストーリー別' } },
  'tracker.group.noEpic': { defaultMessage: 'No epic', translations: { ja: 'エピックなし' } },
  'tracker.group.noStory': { defaultMessage: 'No story', translations: { ja: 'ストーリーなし' } },
  'tracker.group.expand': { defaultMessage: 'Show {name}', translations: { ja: '{name} を開く' } },
  'tracker.group.collapse': { defaultMessage: 'Hide {name}', translations: { ja: '{name} を閉じる' } },
  'tracker.group.newIn': { defaultMessage: 'New issue in {name}', translations: { ja: '{name} に課題を追加' } },
  'tracker.group.inEpic': { defaultMessage: 'In {name}', translations: { ja: '{name} 内' } },
  'tracker.progress.label': { defaultMessage: '{completed} of {total} done', translations: { ja: '{total} 件中 {completed} 件完了' } },

  'tracker.hierarchy.epicNoParent': { defaultMessage: 'An epic cannot have a parent.', translations: { ja: 'エピックには親を設定できません。' } },
  'tracker.hierarchy.storyUnderEpic': { defaultMessage: 'A story can only sit under an epic.', translations: { ja: 'ストーリーの親にできるのはエピックだけです。' } },
  'tracker.hierarchy.self': { defaultMessage: 'An issue cannot be its own parent.', translations: { ja: '自分自身を親にはできません。' } },
  'tracker.hierarchy.otherParent': {
    defaultMessage: 'Its parent is {identifier}. Change it on the issue.',
    translations: { ja: '親は {identifier} です。課題の画面で変更してください。' },
  },
  'tracker.hierarchy.moveRefused': { defaultMessage: "Can't move {identifier} there", translations: { ja: '{identifier} はそこへ移せません' } },
  'tracker.hierarchy.stories': { defaultMessage: 'Stories', translations: { ja: 'ストーリー' } },
  'tracker.hierarchy.workItems': { defaultMessage: 'Work items', translations: { ja: '課題' } },
  'tracker.hierarchy.addExisting': { defaultMessage: 'Add existing issue', translations: { ja: '既存の課題を追加' } },
  'tracker.hierarchy.newChild': { defaultMessage: 'New child issue', translations: { ja: '子課題を作成' } },
  'tracker.hierarchy.empty': { defaultMessage: 'Nothing here yet. Add an existing issue or create one.', translations: { ja: 'まだ何もありません。既存の課題を追加するか、新しく作成してください。' } },
  'tracker.hierarchy.progress': { defaultMessage: 'Progress', translations: { ja: '進み具合' } },

  'tracker.parent.storyOrParent': { defaultMessage: 'Story / parent', translations: { ja: 'ストーリー・親' } },
  'tracker.parent.parent': { defaultMessage: 'Parent', translations: { ja: '親' } },
  'tracker.parent.choose': { defaultMessage: 'Choose a parent', translations: { ja: '親を選ぶ' } },
  'tracker.parent.chooseEpic': { defaultMessage: 'Choose an epic', translations: { ja: 'エピックを選ぶ' } },
  'tracker.parent.none': { defaultMessage: 'None', translations: { ja: 'なし' } },
  'tracker.parent.epicTop': { defaultMessage: 'Epics are the top level and have no parent.', translations: { ja: 'エピックは最上位なので、親はありません。' } },

  'tracker.filter.epic': { defaultMessage: 'Filter by epic', translations: { ja: 'エピックで絞り込む' } },
  'tracker.filter.story': { defaultMessage: 'Filter by story', translations: { ja: 'ストーリーで絞り込む' } },

  'tracker.nav.epics': { defaultMessage: 'Epics', translations: { ja: 'エピック' } },
  'tracker.epics.newEpic': { defaultMessage: 'New epic', translations: { ja: '新しいエピック' } },
  'tracker.epics.newStory': { defaultMessage: 'New story', translations: { ja: '新しいストーリー' } },
  'tracker.epics.newStoryIn': { defaultMessage: 'New story in {name}', translations: { ja: '{name} にストーリーを追加' } },
  'tracker.epics.storyCount': { defaultMessage: '{count} stories', translations: { ja: 'ストーリー {count} 件' } },
  'tracker.epics.directCount': { defaultMessage: '{count} issues directly', translations: { ja: '直下の課題 {count} 件' } },
  'tracker.epics.viewIssues': { defaultMessage: 'View issues', translations: { ja: '課題を見る' } },
  'tracker.epics.viewIssuesOf': { defaultMessage: 'View issues of {name}', translations: { ja: '{name} の課題を見る' } },
  'tracker.epics.noEpic': { defaultMessage: 'Stories without an epic', translations: { ja: 'エピックのないストーリー' } },
  'tracker.epics.unbundled': { defaultMessage: '{count} issues are in no epic or story', translations: { ja: 'どのエピックにもストーリーにも入っていない課題が {count} 件あります' } },
  'tracker.epics.noStories': { defaultMessage: 'No stories yet', translations: { ja: 'ストーリーはまだありません' } },
  'tracker.epics.emptyTitle': { defaultMessage: 'No epics yet', translations: { ja: 'エピックはまだありません' } },
  'tracker.epics.emptyBody': {
    defaultMessage: 'An epic bundles user stories; a story bundles the issues that deliver it.',
    translations: { ja: 'エピックはストーリーを、ストーリーはそれを実現する課題をまとめます。' },
  },
  'tracker.epics.scoped': { defaultMessage: 'Counts include only issues in {name}.', translations: { ja: '{name} の課題だけを数えています。' } },

  'tracker.palette.setEpic': { defaultMessage: 'Set epic…', translations: { ja: 'エピックを設定…' } },
  'tracker.palette.setStory': { defaultMessage: 'Set story…', translations: { ja: 'ストーリーを設定…' } },
  'tracker.palette.removeEpic': { defaultMessage: 'Remove from epic', translations: { ja: 'エピックから外す' } },
  'tracker.palette.removeStory': { defaultMessage: 'Remove from story', translations: { ja: 'ストーリーから外す' } },
  'tracker.palette.goEpics': { defaultMessage: 'Open epics', translations: { ja: 'エピック一覧を開く' } },
  'tracker.bundle.set': { defaultMessage: 'Put {count} issues in {name}', translations: { ja: '{count} 件を {name} に入れました' } },
  'tracker.bundle.removed': { defaultMessage: 'Took {count} issues out', translations: { ja: '{count} 件を外しました' } },
  'tracker.bundle.skipped': { defaultMessage: '{count} skipped: the hierarchy does not allow it.', translations: { ja: '{count} 件は親にできない組み合わせのため飛ばしました。' } },
  'tracker.bundle.skippedOther': { defaultMessage: '{count} skipped: their parent is another issue.', translations: { ja: '{count} 件は親が別の課題のため飛ばしました。' } },
  'tracker.bundle.nothing': { defaultMessage: 'Nothing to change', translations: { ja: '変更できる課題はありませんでした' } },
})
