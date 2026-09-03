import { describe, expect, it } from 'vitest'
import { buildStructuredOutputMetadata } from '../../../structuredOutput/metadata'
import { resolveStructuredRetryDiagnostic } from '../../../lib/structuredRetryDiagnostics'
import {
  getStructuredOutputSourceMessages,
  hasArtifactProcessingNotice,
} from '../../../../src/components/workspace/artifactProcessingNotice'

/**
 * The Manual QA generator retried and repaired without recording any of it, so
 * the client's notice surface showed a generic result and the operator never
 * learned that anything had happened. This is the sequence the generation loop
 * now runs, checked against the surface that renders it.
 */
function metadataForOneRetryThenRepairedSuccess() {
  const validationError = 'Expected exactly one <MANUAL_QA_CHECKLIST> tagged YAML response.'
  let metadata = buildStructuredOutputMetadata(null)
  metadata = buildStructuredOutputMetadata(metadata, {
    autoRetryCount: 1,
    validationError,
    retryDiagnostics: [resolveStructuredRetryDiagnostic({
      attempt: 1,
      rawResponse: 'not a tagged response',
      validationError,
    })],
  })
  return buildStructuredOutputMetadata(metadata, {
    repairApplied: true,
    repairWarnings: ['Quoted hex-color text in Manual QA prose before YAML parsing.'],
    autoRetryCount: 1,
  })
}

describe('Manual QA generation diagnostics', () => {
  it('produces a notice the operator can actually read', () => {
    const metadata = metadataForOneRetryThenRepairedSuccess()

    expect(hasArtifactProcessingNotice(metadata)).toBe(true)
    expect(metadata.autoRetryCount).toBe(1)
    expect(metadata.retryDiagnostics).toHaveLength(1)
    expect(metadata.repairApplied).toBe(true)
  })

  it('names both why the retry happened and what the repair changed', () => {
    const messages = getStructuredOutputSourceMessages(metadataForOneRetryThenRepairedSuccess())

    expect(messages).toContain('Quoted hex-color text in Manual QA prose before YAML parsing.')
    expect(messages).toContain('Expected exactly one <MANUAL_QA_CHECKLIST> tagged YAML response.')
    expect(messages.some((message) => message.includes('Retry attempt 1'))).toBe(true)
  })

  it('shows no notice for a first-pass success', () => {
    // A clean generation must stay quiet; a notice on every checklist would
    // teach the operator to ignore it.
    const metadata = buildStructuredOutputMetadata(buildStructuredOutputMetadata(null), {
      repairApplied: false,
      repairWarnings: [],
      autoRetryCount: 0,
    })
    expect(hasArtifactProcessingNotice(metadata)).toBe(false)
  })
})
