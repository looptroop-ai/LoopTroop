export const FINAL_TEST_FILE_EFFECTS_AUDIT_ARTIFACT = 'final_test_file_effects_audit'

/**
 * What a final-test run says it did to a file.
 *
 * `candidate` is work meant for the branch, `temporary` is scaffolding the run
 * cleans up, and `unexpected` is everything the model could not account for.
 * Lives here rather than beside either reader because both the parser
 * (`server/structuredOutput`) and the auditor (`server/phases/finalTest`) build
 * the same records: they each had their own identical copy, free to drift.
 */
export type FinalTestFileEffectIntent = 'candidate' | 'temporary' | 'unexpected'

export interface FinalTestFileEffect {
  path: string
  intent: FinalTestFileEffectIntent
  reason?: string
}
