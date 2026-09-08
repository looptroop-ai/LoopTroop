import { isRecord } from '@shared/typeGuards'

/**
 * Field checks for artifact payloads the viewers render directly.
 *
 * A stored artifact is whatever the model produced and the server wrote. Valid
 * JSON of the wrong shape used to reach a renderer and throw: an object where a
 * string was expected becomes an invalid React child, and a non-array where an
 * array was expected throws on `.map`. Both take the artifact pane down instead
 * of falling back to the raw view sitting behind it.
 *
 * These are deliberately shallow — they check the fields a view actually reads,
 * not the whole schema — and they are only used to decide *whether the
 * structured branch is safe to take*. The fallback is always the raw content.
 */

/** A string, or absent. Anything else would render as an invalid child. */
export function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/** A number, or absent. */
export function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number'
}

/**
 * A number, absent, or `null`.
 *
 * `null` is a real stored value, not a malformed one: producers write
 * `exitCode: null` and `signal: null`, and the renderers guard them with `??`
 * and truthiness. A guard that rejected `null` would refuse artifacts the app
 * writes itself — which is how the first version of this rejected every
 * final-test report carrying `signal: null`.
 */
export function isNullableNumber(value: unknown): boolean {
  return value === null || isOptionalNumber(value)
}

/** A string, absent, or `null`. See `isNullableNumber` for why `null` counts. */
export function isNullableString(value: unknown): boolean {
  return value === null || isOptionalString(value)
}

/** Absent, or an array whose every entry satisfies `check`. */
export function isOptionalArrayOf(value: unknown, check: (entry: unknown) => boolean): boolean {
  return value === undefined || (Array.isArray(value) && value.every(check))
}

/** An array whose every entry satisfies `check`. */
export function isArrayOf(value: unknown, check: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(check)
}

/** A record whose named fields are all strings (absent fields pass). */
export function hasStringFields(value: unknown, fields: readonly string[]): boolean {
  return isRecord(value) && fields.every((field) => isOptionalString(value[field]))
}

/**
 * Is this safe to hand to `ArtifactProcessingNotice`?
 *
 * The notice filters and iterates the intervention, warning and diagnostic
 * collections without checking them, so a truthy non-array field there throws.
 * Absent is fine — the notice renders nothing.
 */
export function isOptionalStructuredOutput(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (!isRecord(value)) return false
  return [value.interventions, value.warnings, value.retryDiagnostics, value.sourceMessages]
    .every((entry) => entry === undefined || Array.isArray(entry))
}

/**
 * Is this a Manual QA bead origin the origin card can render?
 *
 * `ManualQaOriginCard` calls `origin.sourceItems.map` and reads `evidence.length`
 * on each item without checking either, so a bead carrying
 * `qaOrigin: {}` — valid JSON, wrong shape — crashed the bead view. Treated as
 * "no origin" rather than as a fatal error, which is what the ticket-runtime
 * normaliser already does for the same data.
 */
export function isRenderableManualQaOrigin(value: unknown): boolean {
  if (!isRecord(value)) return false
  // The card renders these three itself: two as children, one through
  // `.replace`.
  if (!hasStringFields(value, ['sourceTicketId', 'sourceTicketExternalId', 'imageDelivery'])) return false
  if (!isOptionalNumber(value.version)) return false
  if (!Array.isArray(value.sourceItems)) return false
  return value.sourceItems.every((item) => (
    isRecord(item)
    // `evidence` and `links` are both read with `.length` and mapped, so
    // neither may be absent — the producer defaults them to `[]`, and
    // `undefined` is precisely the stored legacy shape this guard exists for.
    && isArrayOf(item.evidence, (entry) => hasStringFields(entry, ['id', 'mediaType', 'originalName']))
    && isArrayOf(item.links, (entry) => hasStringFields(entry, ['id', 'url', 'label']))
    && hasStringFields(item, ['itemId', 'lineageId', 'behavior', 'observation', 'expectedResult'])
  ))
}
