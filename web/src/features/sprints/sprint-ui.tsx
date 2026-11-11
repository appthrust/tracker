// Small sprint pieces shared by the sprint pages, issue properties, list
// sections and the palette: the sprint and estimate marks, the state badge,
// date and unit wording, the points/issues toggle and "today" in the
// workspace timezone. Sizes read as sizes (XS…XL); numbers appear only in
// sprint totals and charts.
import { IterationCcw } from 'lucide-react'
import type { Size, Sprint, SprintState, Unit } from '../../api/tracker'
import { useText, type Translate } from '../../i18n'
import { dayInZone, UNITS } from '../../model/sprints'
import { cn } from '../../ui'
import { useReference } from '../issues/use-reference'
import { setUi, useUi } from '../ui-state'

export function SprintIcon({ state, className }: { state?: SprintState; className?: string }) {
  return <IterationCcw aria-hidden className={cn('size-3.5 shrink-0', state === 'active' ? 'text-accent' : 'text-stone-400', className)} />
}

/** The size as a compact mono pill; the accessible name says what it is. */
export function EstimateBadge({ size, className }: { size: Size; className?: string }) {
  const { t } = useText()
  return (
    <span
      title={`${t('tracker.property.estimate')}: ${size}`}
      className={cn('inline-flex h-5 min-w-6 shrink-0 items-center justify-center rounded border border-stone-300 bg-white px-1 font-mono text-[11px] font-semibold text-stone-600', className)}
    >
      <span className="sr-only">{t('tracker.property.estimate')}: </span>
      {size}
    </span>
  )
}

const STATE_TONE: Record<SprintState, string> = {
  active: 'bg-accent-soft text-accent-strong ring-accent-line',
  planned: 'bg-stone-100 text-stone-600 ring-stone-200',
  closed: 'bg-white text-stone-500 ring-stone-200',
}

export function SprintStateBadge({ state }: { state: SprintState }) {
  const { t } = useText()
  return <span className={cn('inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium ring-1 ring-inset', STATE_TONE[state])}>{t(`tracker.sprint.state.${state}`)}</span>
}

/** "11月7日" / "Nov 7" for a YYYY-MM-DD calendar day (no timezone shift). */
export function formatDay(day: string, locale: string, withWeekday = false): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...(withWeekday ? { weekday: 'short' } : {}), timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))
}

export function sprintDates(t: Translate, sprint: Pick<Sprint, 'startsOn' | 'endsOn'>, locale: string): string {
  return t('tracker.sprints.dates', { start: formatDay(sprint.startsOn, locale), end: formatDay(sprint.endsOn, locale) })
}

/** "8 pt" / "3 件": a chart or total value in `unit`. */
export function unitValue(t: Translate, value: number, unit: Unit): string {
  return unit === 'points' ? t('tracker.unit.pointsValue', { count: value }) : t('tracker.list.count', { count: value })
}

/** Today as YYYY-MM-DD in the workspace timezone. */
export function useToday(): string {
  const { workspace } = useReference()
  return dayInZone(Date.now(), workspace.timezone)
}

export function useChartUnit(): [Unit, (unit: Unit) => void] {
  const unit = useUi((state) => state.chartUnit)
  return [unit, (chartUnit) => setUi({ chartUnit })]
}

/** Points / issues switch for the charts (shared across the sprint screens). */
export function UnitToggle({ className }: { className?: string }) {
  const { t } = useText()
  const [unit, setUnit] = useChartUnit()
  return (
    <div role="group" aria-label={t('tracker.unit.label')} className={cn('flex items-center gap-0.5 rounded-md bg-stone-100 p-0.5', className)}>
      {UNITS.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={unit === value}
          onClick={() => setUnit(value)}
          className={cn('h-6 rounded px-2 text-xs text-stone-500 hover:text-stone-900', unit === value && 'bg-white font-medium text-stone-900 shadow-xs')}
        >
          {t(`tracker.unit.${value}`)}
        </button>
      ))}
    </div>
  )
}
