// Hand-written SVG charts over API.md `Burndown` and `Velocity` (no chart
// dependency). Colors are the app's tokens (accent, stone, busy) applied as
// classes, so the charts follow the theme. Each chart is an `img` with a
// title and a one-sentence description, prints its key values as text, and
// offers every value in a table ("Show values"), so nothing needs hover.
// Empty states: a planned sprint has no data yet; a sprint whose issues carry
// no estimate shows nothing in points and points the reader to the issue
// count; velocity waits for the first closed sprint.
import { useId, type ReactNode } from 'react'
import type { Burndown, BurndownPoint, Sprint, Unit, Velocity } from '../../api/tracker'
import { useText } from '../../i18n'
import { isWeekend } from '../../model/sprints'
import { Button, cn } from '../../ui'
import { formatDay, unitValue } from './sprint-ui'

const recorded = (point: BurndownPoint): point is Required<BurndownPoint> => point.remaining !== undefined

/** A round axis maximum (1, 2 or 5 × 10ⁿ steps) at or above `value`; at least 4. */
function niceMax(value: number): number {
  if (value <= 4) return 4
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 5, 10].find((candidate) => candidate * magnitude >= value / 4)! * magnitude
  return Math.ceil(value / step) * step
}

const formatNumber = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1))

/** Why a burndown has nothing to draw, if so: not started (no recorded day) or no estimates in points. */
export function burndownEmptiness(burndown: Burndown, sprint: Pick<Sprint, 'current'>): 'notStarted' | 'noPoints' | undefined {
  const points = burndown.points.filter(recorded)
  if (points.length === 0) return 'notStarted'
  if (burndown.unit === 'points' && sprint.current.scopeIssues > 0 && points.every((point) => point.scope === 0) && burndown.points.every((point) => point.ideal === 0)) return 'noPoints'
  return undefined
}

function ChartEmpty({ children, action, compact }: { children: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-stone-300 bg-stone-50/60 text-center text-stone-500', compact ? 'h-16 px-2 text-[11px]' : 'min-h-40 px-6 py-6 text-sm')}>
      <p className="max-w-sm">{children}</p>
      {action}
    </div>
  )
}

/**
 * Remaining (accent), ideal (dashed), scope (thin) per day, weekends shaded,
 * a today marker. `thumb` is the small version on the sprint card: no axes,
 * no table. `onUseIssues` switches the unit from the empty "no estimates" state.
 */
export function BurndownChart({ burndown, sprint, variant = 'full', onUseIssues }: { burndown: Burndown; sprint: Pick<Sprint, 'name' | 'current'>; variant?: 'full' | 'thumb'; onUseIssues?: () => void }) {
  const { t, locale } = useText()
  const id = useId()
  const thumb = variant === 'thumb'
  const unit = burndown.unit
  const empty = burndownEmptiness(burndown, sprint)
  if (empty === 'notStarted') return <ChartEmpty compact={thumb}>{t('tracker.chart.notStarted')}</ChartEmpty>
  if (empty === 'noPoints')
    return (
      <ChartEmpty
        compact={thumb}
        action={
          onUseIssues && !thumb ? (
            <Button size="sm" onClick={onUseIssues}>
              {t('tracker.chart.switchToIssues')}
            </Button>
          ) : undefined
        }
      >
        {t('tracker.chart.noPoints')}
      </ChartEmpty>
    )

  const points = burndown.points
  const last = [...points].reverse().find(recorded)!
  const todayIndex = points.findIndex((point) => point.day === burndown.today)
  const idealToday = (todayIndex >= 0 ? points[todayIndex]! : points[points.length - 1]!).ideal
  const width = thumb ? 240 : 800
  const height = thumb ? 80 : 200
  const margin = thumb ? { left: 2, right: 2, top: 4, bottom: 4 } : { left: 36, right: 12, top: 12, bottom: 26 }
  const yMax = niceMax(Math.max(...points.map((point) => Math.max(point.ideal, point.scope ?? 0, point.remaining ?? 0))))
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const step = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth
  const x = (index: number) => margin.left + (points.length > 1 ? index * step : plotWidth / 2)
  const y = (value: number) => margin.top + (1 - value / yMax) * plotHeight
  const path = (values: [number, number][]) => values.map(([index, value], at) => `${at === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ')
  const recordedPoints = points.map((point, index) => [point, index] as const).filter((entry): entry is readonly [Required<BurndownPoint>, number] => recorded(entry[0]))
  // About six day labels; the last day always, unless the previous label sits right next to it.
  const labelEvery = Math.max(1, Math.ceil(points.length / 6))
  const labelled = (index: number) => index === points.length - 1 || (index % labelEvery === 0 && points.length - 1 - index >= labelEvery / 2)
  const summary = t('tracker.chart.burndownSummary', {
    day: formatDay(last.day, locale),
    remaining: unitValue(t, last.remaining, unit),
    scope: unitValue(t, last.scope, unit),
    ideal: unitValue(t, Math.round(idealToday * 10) / 10, unit),
  })
  const title = t('tracker.chart.burndownOf', { name: sprint.name })

  return (
    <figure className="min-w-0">
      <svg role="img" aria-labelledby={`${id}-title ${id}-desc`} viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full overflow-visible">
        <title id={`${id}-title`}>{title}</title>
        <desc id={`${id}-desc`}>{summary}</desc>
        {points.map((point, index) =>
          isWeekend(point.day) ? <rect key={point.day} x={x(index) - step / 2} y={margin.top} width={step} height={plotHeight} className="fill-stone-100/70" /> : null
        )}
        {thumb
          ? null
          : [0, yMax / 2, yMax].map((tick) => (
              <g key={tick}>
                <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} className="stroke-stone-200" strokeWidth={1} />
                <text x={margin.left - 6} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-stone-500 text-[10px] tabular-nums">
                  {formatNumber(tick)}
                </text>
              </g>
            ))}
        {thumb
          ? null
          : points.map((point, index) =>
              labelled(index) ? (
                <text key={point.day} x={x(index)} y={height - 8} textAnchor="middle" className="fill-stone-500 text-[10px] tabular-nums">
                  {formatDay(point.day, locale)}
                </text>
              ) : null
            )}
        {todayIndex >= 0 ? (
          <g>
            <line x1={x(todayIndex)} x2={x(todayIndex)} y1={margin.top} y2={margin.top + plotHeight} className="stroke-busy" strokeWidth={thumb ? 1 : 1.5} strokeDasharray="3 3" />
            {thumb ? null : (
              <text x={x(todayIndex) + 4} y={margin.top + 9} className="fill-busy-ink text-[10px] font-medium">
                {t('tracker.chart.today')}
              </text>
            )}
          </g>
        ) : null}
        <path d={path(points.map((point, index) => [index, point.ideal]))} fill="none" className="stroke-stone-400" strokeWidth={thumb ? 1 : 1.5} strokeDasharray="5 4" />
        {thumb ? null : <path d={path(recordedPoints.map(([point, index]) => [index, point.scope]))} fill="none" className="stroke-stone-500" strokeWidth={1} />}
        <path d={path(recordedPoints.map(([point, index]) => [index, point.remaining]))} fill="none" className="stroke-accent" strokeWidth={thumb ? 1.75 : 2.25} strokeLinejoin="round" />
        {thumb
          ? null
          : recordedPoints.map(([point, index]) => (
              <circle key={point.day} cx={x(index)} cy={y(point.remaining)} r={3} className="fill-white stroke-accent" strokeWidth={1.5}>
                <title>{`${formatDay(point.day, locale)}: ${t('tracker.chart.remaining')} ${unitValue(t, point.remaining, unit)}`}</title>
              </circle>
            ))}
      </svg>
      {thumb ? null : (
        <>
          <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-600">
            <Legend swatch="h-0.5 w-4 bg-accent">{t('tracker.chart.remaining')}</Legend>
            <Legend swatch="h-0 w-4 border-t-2 border-dashed border-stone-400">{t('tracker.chart.ideal')}</Legend>
            <Legend swatch="h-px w-4 bg-stone-500">{t('tracker.chart.scope')}</Legend>
            <Legend swatch="h-3 w-0 border-l-2 border-dashed border-busy">{t('tracker.chart.today')}</Legend>
            <span className="ml-auto text-stone-500">{summary}</span>
          </figcaption>
          <ValuesTable
            head={[t('tracker.chart.day'), t('tracker.chart.scope'), t('tracker.chart.completed'), t('tracker.chart.remaining'), t('tracker.chart.ideal')]}
            rows={points.map((point) => [formatDay(point.day, locale, true), point.scope ?? '—', point.done ?? '—', point.remaining ?? '—', formatNumber(point.ideal)])}
            unit={unit}
          />
        </>
      )}
    </figure>
  )
}

function Legend({ swatch, children }: { swatch: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn('inline-block shrink-0', swatch)} />
      {children}
    </span>
  )
}

function ValuesTable({ head, rows, unit }: { head: string[]; rows: (string | number)[][]; unit: Unit }) {
  const { t } = useText()
  return (
    <details className="mt-2 text-xs">
      <summary className="inline-flex cursor-pointer rounded px-1 text-stone-500 hover:text-stone-900">{t('tracker.chart.showValues', { unit: t(`tracker.unit.${unit}`) })}</summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-md border border-line">
        <table className="w-full border-collapse text-left tabular-nums">
          <thead className="sticky top-0 bg-stone-50 text-stone-600">
            <tr>
              {head.map((cell) => (
                <th key={cell} scope="col" className="border-b border-line px-2 py-1 font-medium">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-b border-stone-100 last:border-0">
                {row.map((cell, cellIndex) =>
                  cellIndex === 0 ? (
                    <th key={cellIndex} scope="row" className="px-2 py-1 font-normal text-stone-700">
                      {cell}
                    </th>
                  ) : (
                    <td key={cellIndex} className="px-2 py-1 text-stone-700">
                      {cell}
                    </td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

/** Committed (stone) and completed (accent) bars per closed sprint, oldest first, with the per-week average as a dashed line. */
export function VelocityChart({ velocity }: { velocity: Velocity }) {
  const { t } = useText()
  const id = useId()
  const unit = velocity.unit
  if (velocity.items.length === 0) return <ChartEmpty>{t('tracker.chart.noClosed')}</ChartEmpty>
  const items = velocity.items
  const average = velocity.averagePerWeek
  const width = 720
  const height = 220
  const margin = { left: 36, right: 12, top: 18, bottom: 34 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const yMax = niceMax(Math.max(average ?? 0, ...items.flatMap((item) => [item.committed, item.completed])))
  const y = (value: number) => margin.top + (1 - value / yMax) * plotHeight
  const group = plotWidth / items.length
  const bar = Math.min(26, group * 0.3)
  const center = (index: number) => margin.left + group * (index + 0.5)
  const latest = items[items.length - 1]!
  const summary = t('tracker.chart.velocitySummary', {
    count: items.length,
    latest: unitValue(t, latest.completed, unit),
    average: average === null ? '—' : unitValue(t, average, unit),
  })

  return (
    <figure className="min-w-0">
      <svg role="img" aria-labelledby={`${id}-title ${id}-desc`} viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full overflow-visible">
        <title id={`${id}-title`}>{t('tracker.chart.velocity')}</title>
        <desc id={`${id}-desc`}>{summary}</desc>
        {[0, yMax / 2, yMax].map((tick) => (
          <g key={tick}>
            <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} className="stroke-stone-200" strokeWidth={1} />
            <text x={margin.left - 6} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-stone-500 text-[10px] tabular-nums">
              {formatNumber(tick)}
            </text>
          </g>
        ))}
        {items.map((item, index) => (
          <g key={item.sprint.id}>
            <rect x={center(index) - bar - 1.5} y={y(item.committed)} width={bar} height={Math.max(0, y(0) - y(item.committed))} rx={2} className="fill-stone-300">
              <title>{`${item.sprint.name} · ${t('tracker.chart.committed')} ${unitValue(t, item.committed, unit)}`}</title>
            </rect>
            <rect x={center(index) + 1.5} y={y(item.completed)} width={bar} height={Math.max(0, y(0) - y(item.completed))} rx={2} className="fill-accent">
              <title>{`${item.sprint.name} · ${t('tracker.chart.completed')} ${unitValue(t, item.completed, unit)}`}</title>
            </rect>
            <text x={center(index) - bar / 2 - 1.5} y={y(item.committed) - 4} textAnchor="middle" className="fill-stone-500 text-[10px] tabular-nums">
              {item.committed}
            </text>
            <text x={center(index) + bar / 2 + 1.5} y={y(item.completed) - 4} textAnchor="middle" className="fill-accent-strong text-[10px] font-semibold tabular-nums">
              {item.completed}
            </text>
            <text x={center(index)} y={height - 18} textAnchor="middle" className="fill-stone-600 text-[10px]">
              {item.sprint.name}
            </text>
            {item.lengthWeeks === 2 ? (
              <text x={center(index)} y={height - 6} textAnchor="middle" className="fill-stone-400 text-[9px]">
                {t('tracker.sprints.twoWeeks')}
              </text>
            ) : null}
          </g>
        ))}
        {average !== null ? <line x1={margin.left} x2={width - margin.right} y1={y(average)} y2={y(average)} className="stroke-accent-strong" strokeWidth={1.5} strokeDasharray="6 4" /> : null}
      </svg>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-600">
        <Legend swatch="size-2.5 rounded-sm bg-stone-300">{t('tracker.chart.committed')}</Legend>
        <Legend swatch="size-2.5 rounded-sm bg-accent">{t('tracker.chart.completed')}</Legend>
        <Legend swatch="h-0 w-4 border-t-2 border-dashed border-accent-strong">{average === null ? t('tracker.chart.average') : t('tracker.chart.averageValue', { value: unitValue(t, average, unit) })}</Legend>
        <span className="ml-auto text-stone-500">{summary}</span>
      </figcaption>
      <ValuesTable
        head={[t('tracker.property.sprint'), t('tracker.sprints.length'), t('tracker.chart.committed'), t('tracker.chart.completed')]}
        rows={items.map((item) => [item.sprint.name, item.lengthWeeks === 1 ? t('tracker.sprints.oneWeek') : t('tracker.sprints.twoWeeks'), item.committed, item.completed])}
        unit={unit}
      />
    </figure>
  )
}
