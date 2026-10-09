import { ConfigurationDocsLink } from './ConfigurationDocsLink'
import type { ProfileFormData } from './profileFormData'
import { ManualQaSetting } from '@/components/manual-qa/ManualQaSetting'
import { GitHookPolicySetting } from '@/components/git-hooks/GitHookPolicySetting'
import { IgnoreModeSetting } from '@/components/project/IgnoreModeSetting'
import { AdvancedSettings, AdvancedSettingRow } from '@/components/settings/AdvancedSettings'
import { TriStateSetting } from '@/components/settings/TriStateSetting'
import { InheritableDurationField } from '@/components/settings/InheritableDurationField'
import { AI_QUESTIONS_OPTIONS, AI_QUESTION_WAIT_HINT, AI_QUESTION_WAIT_HELP, AI_QUESTION_WAIT_DISABLED_HINT } from '@/components/settings/aiQuestionOptions'
import { AI_QUESTION_WINDOW_MAX_MS, AI_QUESTION_WINDOW_MIN_MS, formatAiQuestionWindow } from '@shared/aiQuestions'
import { SHARED_PROFILE_DEFAULTS } from '@shared/profileDefaults'

const ignoreDescription = <>Preselect where new projects ignore <span className="font-mono">.looptroop/</span> and <span className="font-mono">.ticket/</span>. Rules are appended; existing file content is not changed.</>

interface ProfileAdvancedSettingsProps {
  formData: ProfileFormData
  updateField: <K extends keyof ProfileFormData>(key: K, value: ProfileFormData[K]) => void
  isOpen: boolean
  onToggle: () => void
  isWaitCustom: boolean
  onWaitChange: (value: number | null) => void
  hasWaitError: boolean
  onValidationChange: (hasError: boolean) => void
  isLoading: boolean
}

export const ProfileAdvancedSettings = ({ formData, updateField, isOpen, onToggle, isWaitCustom, onWaitChange, hasWaitError, onValidationChange, isLoading }: ProfileAdvancedSettingsProps) => (
  <AdvancedSettings isOpen={isOpen} onToggle={onToggle} hasWaitError={hasWaitError} contentClassName="space-y-4">
    <AdvancedSettingRow label="Manual QA checkpoint" description="Preselect whether new projects pause tickets for your QA checklist after final tests." help={
      <ConfigurationDocsLink docsPath="/configuration#manual-qa" label="Manual QA checkpoint" description="Set the Manual QA default for newly attached projects. Open the Manual QA documentation." />
    }>
      <ManualQaSetting idPrefix="profile-manual-qa" value={formData.manualQaEnabled} onChange={value => updateField('manualQaEnabled', value === true)} compact />
    </AdvancedSettingRow>
    <AdvancedSettingRow label="AI questions" className="border-t border-border pt-4" description="Choose whether a model may pause a step to ask you a question. Projects and tickets can override this." help={
      <ConfigurationDocsLink docsPath="/configuration#ai-questions" label="AI questions" description="Choose whether a model may pause a step to ask you a question. Open the AI questions documentation." />
    }>
      <TriStateSetting idPrefix="profile-ai-questions" groupLabel="AI questions setting" options={AI_QUESTIONS_OPTIONS} value={formData.aiQuestionsEnabled} onChange={value => updateField('aiQuestionsEnabled', value === true)} disabled={isLoading} compact />
    </AdvancedSettingRow>
    <div className="pl-4">
      <InheritableDurationField
        label="AI question wait" idPrefix="profile-ai-question-wait"
        value={isWaitCustom ? formData.aiQuestionWindow : null}
        onChange={onWaitChange} onValidationChange={onValidationChange}
        inheritedMs={SHARED_PROFILE_DEFAULTS.aiQuestionWindow} inheritLabel="Default"
        disabled={isLoading || !formData.aiQuestionsEnabled}
        disabledReason={!formData.aiQuestionsEnabled ? AI_QUESTION_WAIT_DISABLED_HINT : undefined}
        minMs={AI_QUESTION_WINDOW_MIN_MS} maxMs={AI_QUESTION_WINDOW_MAX_MS}
        formatValue={formatAiQuestionWindow} hint={AI_QUESTION_WAIT_HINT}
        help={<ConfigurationDocsLink docsPath="/configuration#ai-question-wait" label="AI question wait" description={`${AI_QUESTION_WAIT_HELP} Open the AI question wait documentation.`} />}
      />
    </div>
    <AdvancedSettingRow label="Git hook policy" className="border-t border-border pt-4" description="Preselect how new projects handle repository hooks before implementation." help={
      <ConfigurationDocsLink docsPath="/configuration#git-hook-policy" label="Git hook policy" description="Set the Git hook default for newly attached projects. Open the Git hook policy documentation." />
    }>
      <GitHookPolicySetting value={formData.gitHookPolicy} onChange={value => updateField('gitHookPolicy', value)} compact />
    </AdvancedSettingRow>
    <div className="border-t border-border pt-4">
      <IgnoreModeSetting idPrefix="configuration" description={ignoreDescription} value={formData.ignoreMode} onChange={value => updateField('ignoreMode', value)} />
    </div>
  </AdvancedSettings>
)
