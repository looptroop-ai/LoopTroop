import { useState } from 'react'
import { AdvancedSettings, AdvancedSettingRow } from '@/components/settings/AdvancedSettings'
import { ManualQaSetting } from '@/components/manual-qa/ManualQaSetting'
import { ConfigurationDocsLink } from '@/components/config/ConfigurationDocsLink'
import { TriStateSetting } from '@/components/settings/TriStateSetting'
import { InheritableDurationField } from '@/components/settings/InheritableDurationField'
import { AI_QUESTIONS_INHERITABLE_OPTIONS, AI_QUESTION_WAIT_HINT, AI_QUESTION_WAIT_HELP, AI_QUESTION_WAIT_DISABLED_HINT } from '@/components/settings/aiQuestionOptions'
import { describeSettingSource, type AiQuestionsOverride, type AiQuestionWindowOverride } from '@/lib/aiQuestionSetting'
import type { ManualQaOverride } from '@/lib/manualQaSetting'
import type { Ticket } from '@/hooks/useTickets'
import { AI_QUESTION_WINDOW_MAX_MS, AI_QUESTION_WINDOW_MIN_MS, formatAiQuestionWindow } from '@shared/aiQuestions'
import { useDraftSetting, type DraftActions, type DraftContext } from './useDraftView'

interface DraftAdvancedSettingsProps {
  ticket: Ticket
  context: DraftContext
  actions: DraftActions
  hasWaitError: boolean
  onWaitValidationChange: (hasError: boolean) => void
}

export const DraftAdvancedSettings = ({ ticket, context, actions, hasWaitError, onWaitValidationChange }: DraftAdvancedSettingsProps) => {
  const [isOpen, setIsOpen] = useState(false)
  const [manualQaError, setManualQaError] = useState<string | null>(null)
  const [aiQuestionError, setAiQuestionError] = useState<string | null>(null)
  const areAiSettingsDisabled = actions.isStarting || context.isLoading
  const manualQa = useDraftSetting({
    savedValue: ticket.manualQaOverride,
    onSave: (value) => actions.updateTicket({ id: ticket.id, manualQaOverride: value }),
    disabled: actions.isStarting,
    onError: setManualQaError,
    fallbackError: 'Failed to update Manual QA setting.',
  })
  const questions = useDraftSetting({
    savedValue: ticket.aiQuestionsOverride,
    onSave: (value) => actions.updateTicket({ id: ticket.id, aiQuestionsOverride: value }),
    disabled: areAiSettingsDisabled,
    onError: setAiQuestionError,
    fallbackError: 'Failed to update the AI questions setting.',
  })
  const questionsEnabled = questions.value ?? context.inheritedAiQuestions.enabled
  const isWaitDisabled = areAiSettingsDisabled || !questionsEnabled
  const wait = useDraftSetting({
    savedValue: ticket.aiQuestionWindowOverride,
    onSave: (value) => actions.updateTicket({ id: ticket.id, aiQuestionWindowOverride: value }),
    disabled: isWaitDisabled,
    onError: setAiQuestionError,
    fallbackError: 'Failed to update the AI question wait.',
  })
  const manualQaEnabled = manualQa.value ?? context.inheritedManualQa.enabled

  return (
    <div className="w-full" aria-busy={actions.isSaving}>
      <AdvancedSettings isOpen={isOpen} onToggle={() => setIsOpen((open) => !open)} hasWaitError={hasWaitError}>
        <DraftManualQaRow value={manualQa.value} onChange={manualQa.onChange} inheritedEnabled={manualQaEnabled} disabled={actions.isStarting} />
        <DraftAiQuestionsRow value={questions.value} onChange={questions.onChange} inherited={context.inheritedAiQuestions} disabled={areAiSettingsDisabled} />
        <DraftAiQuestionWait value={wait.value} onChange={wait.onChange} inherited={context.inheritedAiQuestionWindow} disabled={isWaitDisabled} questionsEnabled={questionsEnabled} onValidationChange={onWaitValidationChange} />
      </AdvancedSettings>
      <DraftSettingError message={manualQaError} />
      <DraftSettingError message={aiQuestionError} />
    </div>
  )
}

interface DraftManualQaRowProps {
  value: ManualQaOverride
  onChange: (value: ManualQaOverride) => void
  inheritedEnabled: boolean
  disabled: boolean
}

export const DraftManualQaRow = (props: DraftManualQaRowProps) => (
  <AdvancedSettingRow
    label="Manual QA checkpoint"
    description="Choose whether this ticket pauses for your QA checklist after final tests."
    help={<ConfigurationDocsLink docsPath="/configuration#manual-qa" label="ticket Manual QA checkpoint" description="Choose whether this ticket pauses for your verification after final tests. Open the Manual QA documentation." />}
  >
    <ManualQaSetting {...props} idPrefix="draft-manual-qa" compact />
  </AdvancedSettingRow>
)

interface DraftAiQuestionsRowProps {
  value: AiQuestionsOverride
  onChange: (value: AiQuestionsOverride) => void
  inherited: DraftContext['inheritedAiQuestions']
  disabled: boolean
}

export const DraftAiQuestionsRow = ({ value, onChange, inherited, disabled }: DraftAiQuestionsRowProps) => (
  <AdvancedSettingRow
    label="AI questions"
    className="border-t border-border pt-3"
    description="Choose whether a model may pause a step to ask you a question."
    help={<ConfigurationDocsLink docsPath="/configuration#ai-questions" label="ticket AI questions" description="Choose whether a model may pause a step to ask you a question in this ticket. Open the AI questions documentation." />}
  >
    <TriStateSetting
      idPrefix="draft-ai-questions"
      groupLabel="AI questions setting"
      options={AI_QUESTIONS_INHERITABLE_OPTIONS}
      value={value}
      onChange={onChange}
      disabled={disabled}
      footer={value === null && (
        <p className="mt-1 text-right text-xs text-muted-foreground">
          Inherits <span className="font-medium text-foreground">{inherited.enabled ? 'On' : 'Off'}</span> from {describeSettingSource(inherited.source)}.
        </p>
      )}
    />
  </AdvancedSettingRow>
)

interface DraftAiQuestionWaitProps {
  value: AiQuestionWindowOverride
  onChange: (value: AiQuestionWindowOverride) => void
  inherited: DraftContext['inheritedAiQuestionWindow']
  disabled: boolean
  questionsEnabled: boolean
  onValidationChange: (hasError: boolean) => void
}

export const DraftAiQuestionWait = ({ value, onChange, inherited, disabled, questionsEnabled, onValidationChange }: DraftAiQuestionWaitProps) => (
  <div className="pl-4">
    <InheritableDurationField
      label="AI question wait"
      idPrefix="draft-ai-question-wait"
      value={value}
      onChange={onChange}
      onValidationChange={onValidationChange}
      commitOnBlur
      inheritedMs={inherited.windowMs}
      inheritedSourceLabel={describeSettingSource(inherited.source)}
      minMs={AI_QUESTION_WINDOW_MIN_MS}
      maxMs={AI_QUESTION_WINDOW_MAX_MS}
      formatValue={formatAiQuestionWindow}
      disabled={disabled}
      disabledReason={!questionsEnabled ? AI_QUESTION_WAIT_DISABLED_HINT : undefined}
      hint={AI_QUESTION_WAIT_HINT}
      help={<ConfigurationDocsLink docsPath="/configuration#ai-question-wait" label="ticket AI question wait" description={`${AI_QUESTION_WAIT_HELP} Open the AI question wait documentation.`} />}
    />
  </div>
)

export const DraftSettingError = ({ message }: { message: string | null }) => (
  message && <p role="alert" className="mt-2 text-xs text-destructive">{message}</p>
)
