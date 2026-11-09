// The AppThrust-specific bug report fields (API.md `Report`), shared by the
// report form, the new-issue dialog (type = bug) and the report editor on an
// issue. Environment is a free label with suggestions (native combobox).
import { useId } from 'react'
import { useText } from '../../i18n'
import { ENVIRONMENT_SUGGESTIONS, REPORT_TEXT_MAX, SURFACES, type ReportDraft } from '../../model/issues'
import { Field, SelectInput, TextArea, TextInput } from '../../ui'

export const EMPTY_REPORT: ReportDraft = { environment: '', surface: '', version: '', steps: '', expected: '', actual: '' }

export type ReportProblems = Partial<Record<keyof ReportDraft, 'required' | 'tooLong'>>

export function ReportFields({
  draft,
  onChange,
  problems,
  compact = false,
}: {
  draft: ReportDraft
  onChange: (draft: ReportDraft) => void
  problems: ReportProblems
  /** Only environment and surface (the new-issue dialog). */
  compact?: boolean
}) {
  const { t } = useText()
  const id = useId()
  const set = (key: keyof ReportDraft) => (event: { target: { value: string } }) => onChange({ ...draft, [key]: event.target.value })
  const error = (key: keyof ReportDraft) =>
    problems[key] === 'required' ? t('tracker.form.required') : problems[key] === 'tooLong' ? t('tracker.form.tooLong', { max: REPORT_TEXT_MAX }) : undefined
  const text = (key: 'steps' | 'expected' | 'actual', rows: number) => (
    <Field id={`${id}-${key}`} label={t(`tracker.report.${key}`)} hint={t(`tracker.report.${key}Hint`)} error={error(key)}>
      <TextArea id={`${id}-${key}`} rows={rows} value={draft[key]} invalid={Boolean(problems[key])} onChange={set(key)} className="min-h-0" />
    </Field>
  )
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id={`${id}-environment`} label={t('tracker.report.environment')} required error={error('environment')} hint={t('tracker.report.environmentHint')}>
          <TextInput id={`${id}-environment`} list={`${id}-environments`} value={draft.environment} invalid={Boolean(problems.environment)} onChange={set('environment')} autoComplete="off" />
          <datalist id={`${id}-environments`}>
            {ENVIRONMENT_SUGGESTIONS.map((environment) => (
              <option key={environment} value={environment} />
            ))}
          </datalist>
        </Field>
        <Field id={`${id}-surface`} label={t('tracker.report.surface')} required error={error('surface')}>
          <SelectInput id={`${id}-surface`} value={draft.surface} invalid={Boolean(problems.surface)} onChange={set('surface')}>
            <option value="">{t('tracker.report.surfacePlaceholder')}</option>
            {SURFACES.map((surface) => (
              <option key={surface} value={surface}>
                {t(`tracker.surface.${surface}`)}
              </option>
            ))}
          </SelectInput>
        </Field>
        {compact ? null : (
          <Field id={`${id}-version`} label={t('tracker.report.version')} hint={t('tracker.report.versionHint')} error={error('version')}>
            <TextInput id={`${id}-version`} value={draft.version} invalid={Boolean(problems.version)} onChange={set('version')} placeholder="0.42.1" />
          </Field>
        )}
      </div>
      {compact ? null : (
        <>
          {text('steps', 4)}
          <div className="grid gap-4 sm:grid-cols-2">
            {text('expected', 3)}
            {text('actual', 3)}
          </div>
        </>
      )}
    </div>
  )
}
