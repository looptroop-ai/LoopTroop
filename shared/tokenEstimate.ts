/**
 * Rough token count: four characters per token.
 *
 * Every model tokenizes differently, so an exact count for one tokenizer is
 * still an estimate for the model that actually runs. This is close for English
 * prose and code, and counts less than half the real tokens of CJK text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
