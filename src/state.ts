/**
 * CarryOn fold state carried across folds in `compaction/summary.rawOutput`.
 *
 * P0 spike: the state only counts folds, so we can see it survive across folds and session resume.
 * Later steps put carriers, the candidate registry and the execution context here (design doc §4.1).
 *
 * @module dsh-carryon/state
 */

/** Marker key of the JSON object stored in the rawOutput text block. */
export const STATE_KEY = 'carryon_state'

/** Current state format version; readers reject versions they do not know. */
export const STATE_VERSION = 0

/** Fold state that must survive resume, fork and replay. */
export interface CarryOnState {
  readonly v: typeof STATE_VERSION
  /** Number of committed folds in this session, including the one that wrote this state. */
  readonly folds: number
}

/** A text content block, structurally compatible with dsh-llm's `TextBlock`. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** The state before the first fold. */
export const INITIAL_STATE: CarryOnState = Object.freeze({ v: STATE_VERSION, folds: 0 })

/**
 * Encode the state as the single text block stored in `rawOutput`.
 * @param state - state after the fold being committed.
 * @returns one text block holding `{"carryon_state": state}`.
 */
export function encodeState(state: CarryOnState): TextBlock {
  return { type: 'text', text: JSON.stringify({ [STATE_KEY]: state }) }
}

/**
 * Decode state from a `compaction/summary` rawOutput, if this plugin wrote it.
 * @param rawOutput - the event's rawOutput blocks (any shape; other backends write other content).
 * @returns the state, or `undefined` when the blocks hold no state of a known version.
 */
export function decodeState(rawOutput: unknown): CarryOnState | undefined {
  if (!Array.isArray(rawOutput)) return undefined
  for (const block of rawOutput) {
    if (typeof block !== 'object' || block === null) continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type !== 'text' || typeof text !== 'string') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    const state = (parsed as Record<string, unknown> | null)?.[STATE_KEY]
    if (isState(state)) return state
  }
  return undefined
}

function isState(value: unknown): value is CarryOnState {
  if (typeof value !== 'object' || value === null) return false
  const { v, folds } = value as { v?: unknown; folds?: unknown }
  return v === STATE_VERSION && typeof folds === 'number' && Number.isInteger(folds) && folds >= 0
}
