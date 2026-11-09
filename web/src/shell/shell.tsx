// App frame: a Linear-style sidebar (workspace, issues, board, saved views,
// report, settings, keyboard hint, language, app switcher, the signed-in
// person) beside the page, plus the overlays every page shares (new issue,
// command palette, toasts) and the global keys: C, Shift+R, ⌘/Ctrl+K, `/`.
import { AppSwitcher } from '@appthrust/app-launcher'
import { useNavigate } from '@tanstack/react-router'
import { Bookmark, Bug, Columns3, Command, Languages, List, Menu, Plus, Search, Settings, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { FILTER_INPUT_ID } from '../features/issues/filter-bar'
import { NewIssueDialog } from '../features/issues/new-issue-dialog'
import { CommandPalette } from '../features/palette/command-palette'
import { insideOverlay, isPlainShortcut, isTypingTarget, MOD_KEY, setUi, uiStore } from '../features/ui-state'
import { setLanguage, useText } from '../i18n'
import { paths } from '../routes/paths'
import { Avatar, cn, HrefLink, Kbd, Toaster } from '../ui'
import { useSession } from './use-session'

const NAV_LINK = 'flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-stone-600 hover:bg-stone-200/50 hover:text-stone-900 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-stone-400'
const NAV_ACTIVE = { className: 'bg-stone-200/70 font-medium text-stone-900 [&_svg]:text-stone-600' }

function useGlobalKeys() {
  const navigate = useNavigate()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setUi((state) => ({ palette: !state.palette }))
        return
      }
      if (uiStore.state.palette || uiStore.state.newIssue) return
      // Shift is part of Shift+R, so only typing, overlays and other modifiers are excluded.
      const shiftR = event.shiftKey && (event.key === 'R' || event.key === 'r') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing
      if (shiftR && !event.defaultPrevented && !isTypingTarget(event.target) && !insideOverlay(event.target)) {
        event.preventDefault()
        void navigate({ to: paths.report } as never)
        return
      }
      if (!isPlainShortcut(event)) return
      if ((event.key === 'c' || event.key === 'C') && !event.shiftKey) {
        event.preventDefault()
        setUi({ newIssue: {} })
      } else if (event.key === '/') {
        const input = document.getElementById(FILTER_INPUT_ID)
        if (input) {
          event.preventDefault()
          input.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [navigate])
}

export function Shell({ children }: { children: ReactNode }) {
  const { t, language } = useText()
  const { me, workspace, views } = useSession()
  const [menuOpen, setMenuOpen] = useState(false)
  useGlobalKeys()

  const sidebar = (
    <div className="flex h-full flex-col gap-4 px-2.5 py-3">
      <div className="flex items-center gap-2 px-1.5">
        <span aria-hidden className="grid size-6 place-items-center rounded-md bg-accent text-[11px] font-bold text-white">
          {workspace.key.slice(0, 2)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-stone-900" title={workspace.name}>
          {t('tracker.product')}
        </span>
        <AppSwitcher language={language} />
      </div>
      <div className="flex gap-1.5 px-0.5">
        <button
          type="button"
          onClick={() => setUi({ newIssue: {} })}
          className="flex h-8 flex-1 items-center gap-2 rounded-md border border-line bg-white px-2 text-[13px] text-stone-700 shadow-xs hover:bg-stone-50"
        >
          <Plus aria-hidden className="size-4 text-stone-500" />
          {t('tracker.nav.newIssue')}
          <Kbd className="ml-auto">C</Kbd>
        </button>
        <button
          type="button"
          onClick={() => setUi({ palette: true })}
          aria-label={t('tracker.palette.title')}
          title={`${t('tracker.palette.title')} (${MOD_KEY}K)`}
          className="flex size-8 items-center justify-center rounded-md border border-line bg-white text-stone-500 shadow-xs hover:bg-stone-50"
        >
          <Search aria-hidden className="size-4" />
        </button>
      </div>
      <nav aria-label={t('tracker.nav.label')} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <div className="space-y-0.5">
          <HrefLink href={paths.home} className={NAV_LINK} activeProps={NAV_ACTIVE} activeOptions={{ includeSearch: false }} onClick={() => setMenuOpen(false)}>
            <List aria-hidden />
            {t('tracker.nav.issues')}
          </HrefLink>
          <HrefLink href={paths.board} className={NAV_LINK} activeProps={NAV_ACTIVE} activeOptions={{ includeSearch: false }} onClick={() => setMenuOpen(false)}>
            <Columns3 aria-hidden />
            {t('tracker.nav.board')}
          </HrefLink>
          <HrefLink href={paths.report} className={NAV_LINK} activeProps={NAV_ACTIVE} activeOptions={{ includeSearch: false }} onClick={() => setMenuOpen(false)}>
            <Bug aria-hidden />
            {t('tracker.nav.report')}
            <Kbd className="ml-auto">⇧R</Kbd>
          </HrefLink>
        </div>
        <div>
          <p className="px-2 pb-1 text-[11px] font-medium text-stone-400">{t('tracker.nav.views')}</p>
          <ul className="space-y-0.5">
            {views.map((view) => (
              <li key={view.id}>
                <HrefLink href={paths.view(view.id)} className={NAV_LINK} activeProps={NAV_ACTIVE} activeOptions={{ includeSearch: false }} onClick={() => setMenuOpen(false)}>
                  <Bookmark aria-hidden />
                  <span className="truncate">{view.name}</span>
                  {view.shared ? <span className="ml-auto text-[10px] text-stone-400">{t('tracker.view.shared')}</span> : null}
                </HrefLink>
              </li>
            ))}
            {views.length === 0 ? <li className="px-2 text-xs text-stone-400">{t('tracker.nav.noViews')}</li> : null}
          </ul>
        </div>
      </nav>
      <div className="space-y-0.5 border-t border-line pt-2">
        <HrefLink href={paths.settingsWorkspace} className={NAV_LINK} activeProps={NAV_ACTIVE} activeOptions={{ exact: false, includeSearch: false }} onClick={() => setMenuOpen(false)}>
          <Settings aria-hidden />
          {t('tracker.nav.settings')}
        </HrefLink>
        <button type="button" onClick={() => setUi({ palette: true })} className={cn(NAV_LINK, 'w-full')}>
          <Command aria-hidden />
          {t('tracker.palette.title')}
          <Kbd className="ml-auto">{`${MOD_KEY}K`}</Kbd>
        </button>
        <button
          type="button"
          className={cn(NAV_LINK, 'w-full')}
          aria-label={`${t('tracker.nav.language')}: ${t(language === 'ja' ? 'tracker.language.en' : 'tracker.language.ja')}`}
          onClick={() => setLanguage(language === 'ja' ? 'en' : 'ja')}
        >
          <Languages aria-hidden />
          <span lang={language === 'ja' ? 'en' : 'ja'}>{t(language === 'ja' ? 'tracker.language.en' : 'tracker.language.ja')}</span>
        </button>
        <div className="flex h-9 items-center gap-2 px-2 text-[13px] text-stone-700">
          <Avatar name={me.name} size="xs" />
          <span className="min-w-0 flex-1 truncate">
            <span className="sr-only">{t('tracker.nav.you')}: </span>
            {me.name}
          </span>
          {me.isAdmin ? <span className="rounded bg-stone-200/70 px-1.5 text-[10px] text-stone-500">{t('tracker.nav.admin')}</span> : null}
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex h-dvh min-h-0 flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only z-50 min-h-10 content-center rounded-md bg-white px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('tracker.nav.skipToMain')}
      </a>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-stone-50 px-3 md:hidden">
        <button
          type="button"
          aria-label={menuOpen ? t('tracker.common.close') : t('tracker.nav.menu')}
          aria-expanded={menuOpen}
          aria-controls="tracker-sidebar"
          onClick={() => setMenuOpen((open) => !open)}
          className="flex size-9 items-center justify-center rounded-md text-stone-600 hover:bg-stone-200/60"
        >
          {menuOpen ? <X aria-hidden className="size-5" /> : <Menu aria-hidden className="size-5" />}
        </button>
        <span className="text-sm font-semibold text-stone-900">{t('tracker.product')}</span>
      </header>
      <aside
        id="tracker-sidebar"
        aria-label={t('tracker.nav.label')}
        className={cn(
          'shrink-0 border-line bg-stone-50 md:block md:h-full md:w-56 md:border-r',
          menuOpen ? 'fixed inset-x-0 top-12 bottom-0 z-40 block overflow-y-auto border-t' : 'hidden'
        )}
      >
        {sidebar}
      </aside>
      <main id="main" tabIndex={-1} className="min-h-0 min-w-0 flex-1 bg-white focus:outline-none">
        {children}
      </main>
      <NewIssueDialog />
      <CommandPalette />
      <Toaster />
    </div>
  )
}
