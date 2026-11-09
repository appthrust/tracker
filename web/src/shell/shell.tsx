import { AppSwitcher } from '@appthrust/app-launcher'
import { FileText, House, Languages, PenLine } from 'lucide-react'
import type { ReactNode } from 'react'
import { setLanguage, useText } from '../i18n'
import { paths } from '../routes/paths'
import { Avatar, Button, cn, HrefLink, LinkButton } from '../ui'
import { useSession } from './use-session'

const NAV_LINK =
  'flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 md:min-h-9 [&_svg]:size-4 [&_svg]:shrink-0'
const NAV_ACTIVE = { className: 'bg-accent-soft text-accent-strong hover:bg-accent-soft hover:text-accent-strong' }
// Two sections, 書く, the language switch, the switcher and the signed-in author do not fit a phone's width;
// below `sm` the section links show their icon and keep the label for screen readers and as a tooltip.
const NAV_LABEL = 'max-sm:sr-only'

/** Top bar (brand, sections, 書く, language, the app switcher, the signed-in author) over the page. */
export function Shell({ children }: { children: ReactNode }) {
  const { t, language } = useText()
  const { me } = useSession()
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 min-h-10 content-center rounded-md bg-white px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('tracker.nav.skipToMain')}
      </a>
      <header className="sticky top-0 z-10 border-b border-line bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-1 px-3 sm:gap-2 sm:px-6">
          <HrefLink href={paths.home} className="mr-2 flex shrink-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight text-stone-900" activeOptions={{ includeSearch: false }}>
            <span aria-hidden className="grid size-6 place-items-center rounded-md bg-accent text-xs font-bold text-white">
              {t('tracker.productMark')}
            </span>
            <span className="hidden sm:inline">{t('tracker.product')}</span>
          </HrefLink>
          <nav aria-label={t('tracker.nav.label')} className="flex min-w-0 items-center gap-1">
            <HrefLink href={paths.home} title={t('tracker.nav.home')} className={NAV_LINK} activeProps={NAV_ACTIVE} activeOptions={{ includeSearch: false }}>
              <House aria-hidden />
              <span className={NAV_LABEL}>{t('tracker.nav.home')}</span>
            </HrefLink>
            <HrefLink href={paths.drafts} title={t('tracker.nav.drafts')} className={NAV_LINK} activeProps={NAV_ACTIVE}>
              <FileText aria-hidden />
              <span className={NAV_LABEL}>{t('tracker.nav.drafts')}</span>
            </HrefLink>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <LinkButton href={paths.newArticle} tone="primary" size="sm" icon={<PenLine />} title={t('tracker.nav.write')} className="max-sm:w-10 max-sm:px-0">
              <span className="max-sm:sr-only">{t('tracker.nav.write')}</span>
            </LinkButton>
            <Button
              tone="ghost"
              size="sm"
              icon={<Languages />}
              aria-label={`${t('tracker.nav.language')}: ${t(language === 'ja' ? 'tracker.language.en' : 'tracker.language.ja')}`}
              onClick={() => setLanguage(language === 'ja' ? 'en' : 'ja')}
            >
              <span lang={language === 'ja' ? 'en' : 'ja'} className="hidden sm:inline">
                {t(language === 'ja' ? 'tracker.language.en' : 'tracker.language.ja')}
              </span>
            </Button>
            <AppSwitcher language={language} />
            <HrefLink href={paths.author(me.author.id)} className={cn(NAV_LINK, 'pl-1.5')} activeProps={NAV_ACTIVE}>
              <Avatar name={me.author.displayName} size="sm" />
              <span className="max-w-32 truncate max-md:sr-only">
                <span className="sr-only">{t('tracker.nav.you')}: </span>
                {me.author.displayName}
              </span>
            </HrefLink>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl px-4 py-6 focus:outline-none sm:px-6 md:py-8">
        {children}
      </main>
    </div>
  )
}
