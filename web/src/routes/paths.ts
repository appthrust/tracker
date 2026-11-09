// Every tracker URL. `/articles/<id>` is the article URL other people share;
// `/me` is the signed-in author's own page.

/** The timeline tab: everyone's articles or only the followed authors'. */
export type TimelineTab = 'all' | 'following'

export const paths = {
  home: '/',
  timeline: (tab: TimelineTab) => (tab === 'following' ? '/?feed=following' : '/'),
  newArticle: '/articles/new',
  article: (articleId: string) => `/articles/${encodeURIComponent(articleId)}`,
  editArticle: (articleId: string) => `/articles/${encodeURIComponent(articleId)}/edit`,
  drafts: '/drafts',
  author: (authorId: string) => `/authors/${encodeURIComponent(authorId)}`,
  me: '/me',
}
