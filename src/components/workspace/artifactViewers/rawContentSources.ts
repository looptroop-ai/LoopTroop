import { useEffect, useState } from 'react'

/**
 * Selection logic for the raw tab: which model's output, and which attempt of
 * it, the user is currently looking at.
 */

export interface RawContentSource {
  id: string
  label: string
  content?: string
  displayContent?: string
  modelId?: string
  disabled?: boolean
  title?: string
  variants?: RawContentVariant[]
}

export interface RawContentVariant {
  id: string
  label: string
  content?: string
  displayContent?: string
  disabled?: boolean
  title?: string
  ariaLabel?: string
  labelClassName?: string
  skipDedupe?: boolean
}

export interface ActiveRawContentSource {
  id: string
  label: string
  content?: string
  displayContent?: string
  modelId?: string
  disabled?: boolean
  title?: string
  parentId: string
}

export function normalizeRawContentSource(source: RawContentSource): ActiveRawContentSource {
  return {
    ...source,
    parentId: source.id,
  }
}

export function normalizeRawContentVariant(source: RawContentSource, variant: RawContentVariant): ActiveRawContentSource {
  return {
    ...variant,
    modelId: source.modelId,
    parentId: source.id,
  }
}

/** Find the first non-disabled validated variant. Checks variant.id for `:validated`
 *  or variant.label for a case-insensitive "validated" match. */
export function findFirstValidatedVariant(variants: RawContentVariant[]): RawContentVariant | undefined {
  return variants.find(
    (v) => !v.disabled && (v.id.includes(':validated') || /validated/i.test(v.label)),
  )
}

export function getRawSourceDefaultSelection(source: RawContentSource): ActiveRawContentSource | null {
  if (source.variants?.length) {
    const validatedVariant = findFirstValidatedVariant(source.variants)
    if (validatedVariant) return normalizeRawContentVariant(source, validatedVariant)
    const variant = source.variants.find((entry) => !entry.disabled)
    return variant ? normalizeRawContentVariant(source, variant) : null
  }
  return source.disabled ? null : normalizeRawContentSource(source)
}

export function findRawSourceSelection(sources: RawContentSource[], selectionId: string): ActiveRawContentSource | null {
  for (const source of sources) {
    if (source.variants?.length) {
      const variant = source.variants.find((entry) => entry.id === selectionId && !entry.disabled)
      if (variant) return normalizeRawContentVariant(source, variant)
      if (source.id === selectionId) return getRawSourceDefaultSelection(source)
      continue
    }
    if (source.id === selectionId && !source.disabled) return normalizeRawContentSource(source)
  }
  return null
}

export function isRawContentSourceSelectable(source: RawContentSource): boolean {
  return getRawSourceDefaultSelection(source) !== null
}

export function canShowRawSourceSelector(rawSourceOptions: RawContentSource[]): boolean {
  return rawSourceOptions.length > 1
    || rawSourceOptions.some((source) => Boolean(source.modelId) || (source.variants?.length ?? 0) > 1)
}

export function shouldOmitAggregateRawSource(rawSources: RawContentSource[] | undefined): boolean {
  const selectableSources = rawSources?.filter(isRawContentSourceSelectable) ?? []
  return selectableSources.length === 1 && Boolean(selectableSources[0]?.modelId)
}

export function buildAggregateRawSource(content: string, rawSources: RawContentSource[] | undefined): RawContentSource {
  const rawSourceCount = rawSources?.length ?? 0
  const selectableSourceCount = rawSources?.filter(isRawContentSourceSelectable).length ?? 0
  const hasMultipleSelectableSources = selectableSourceCount > 1 || (selectableSourceCount === 0 && rawSourceCount > 1)
  return {
    id: 'all',
    label: hasMultipleSelectableSources ? 'All Models' : 'Artifact',
    content,
    title: hasMultipleSelectableSources ? 'Show raw artifact for all models' : 'Show stored raw artifact',
  }
}

export function getRawSourceFallbackSelection(sources: RawContentSource[]): ActiveRawContentSource | null {
  // First pass: prefer a source that has a validated variant
  for (const source of sources) {
    if (source.variants?.length) {
      const validatedVariant = findFirstValidatedVariant(source.variants)
      if (validatedVariant) return normalizeRawContentVariant(source, validatedVariant)
    }
  }
  // Fallback: first selectable source
  for (const source of sources) {
    const selection = getRawSourceDefaultSelection(source)
    if (selection) return selection
  }
  return sources[0] ? normalizeRawContentSource(sources[0]) : null
}

/**
 * Holds the selected raw-attempt variant, and snaps the selection back when the
 * one being shown disappears — which happens whenever a new attempt arrives and
 * re-derives the variant list.
 *
 * Two artifact views wrote this out identically, differing only in the id they
 * fall back to when nothing is selectable. The fallback order is preserved
 * exactly: the currently selected enabled variant, else the first validated
 * one, else the first enabled one, else the first variant at all.
 */
export function useActiveRawVariant(variants: RawContentVariant[], fallbackId: string): {
  activeRawVariant: RawContentVariant | undefined
  activeRawVariantId: string
  setActiveRawVariantId: (variantId: string) => void
} {
  const [activeRawVariantId, setActiveRawVariantId] = useState(fallbackId)

  const activeRawVariant = variants.find((variant) => variant.id === activeRawVariantId && !variant.disabled)
    ?? findFirstValidatedVariant(variants)
    ?? variants.find((variant) => !variant.disabled)
    ?? variants[0]

  useEffect(() => {
    if (!variants.some((variant) => variant.id === activeRawVariantId && !variant.disabled)) {
      const validatedVariant = findFirstValidatedVariant(variants)
      setActiveRawVariantId(validatedVariant?.id ?? variants.find((variant) => !variant.disabled)?.id ?? fallbackId)
    }
  }, [activeRawVariantId, fallbackId, variants])

  return { activeRawVariant, activeRawVariantId, setActiveRawVariantId }
}
