/**
 * CarryOn state carried across folds in `compaction/summary.rawOutput` (design doc §4.1).
 *
 * Version 1 holds what the next fold needs: the task text (§4.2), the current version of every committed carrier,
 * the candidates still in the registry, the execution context, and where the next fold's step numbers start.
 * Older carrier versions are not kept: validation and materialization only need the current one. Version 0 (the P0
 * fold counter) is read and upgraded to an empty version 1 state.
 *
 * The JSON is shown to users in the Trajectory inspector ("Raw Output"), so it must stay readable and secret-free.
 *
 * @module dsh-carryon/state
 */

import { z } from 'zod'
import { Candidate, CarrierRecord, ExecutionContext } from './records.ts'

/** Marker key of the JSON object stored in the rawOutput text block. */
export const STATE_KEY = 'carryon_state'

/** Current state format version; readers reject versions they do not know. */
export const STATE_VERSION = 1

/** Fold state that must survive resume, fork and replay. */
export const CarryOnState = z.object({
  v: z.literal(STATE_VERSION),
  /** Committed CarryOn folds in this session, including the one that wrote this state. */
  folds: z.number().int().nonnegative(),
  /** The original task, taken from the first user message of the first fold. */
  task: z.string().nullable(),
  /** Step number of the first message the next fold will number (interaction messages folded so far). */
  next_step: z.number().int().nonnegative(),
  /** Current version of every committed carrier, in first-commit order. */
  carriers: z.array(CarrierRecord),
  /** Candidates registered by earlier scans and not yet compiled. */
  candidates: z.array(Candidate),
  ec: ExecutionContext,
})
export type CarryOnState = z.output<typeof CarryOnState>

const StateV0 = z.object({ v: z.literal(0), folds: z.number().int().nonnegative() })

/** A text content block, structurally compatible with dsh-llm's `TextBlock`. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** The state before the first fold. */
export const INITIAL_STATE: CarryOnState = Object.freeze({
  v: STATE_VERSION,
  folds: 0,
  task: null,
  next_step: 0,
  carriers: [],
  candidates: [],
  ec: ExecutionContext.parse({}),
})

/**
 * Encode the state as the single text block stored in `rawOutput`.
 * @param state - state after the fold being committed.
 * @returns one text block holding `{"carryon_state": state}`, pretty-printed for the Trajectory inspector.
 */
export function encodeState(state: CarryOnState): TextBlock {
  return { type: 'text', text: JSON.stringify({ [STATE_KEY]: state }, null, 2) }
}

/**
 * Decode state from a `compaction/summary` rawOutput, if this plugin wrote it.
 * @param rawOutput - the event's rawOutput blocks (any shape; other backends write other content).
 * @returns the state (version 0 upgraded), or `undefined` when the blocks hold no state of a known version.
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
    const raw = (parsed as Record<string, unknown> | null)?.[STATE_KEY]
    const v1 = CarryOnState.safeParse(raw)
    if (v1.success) return v1.data
    const v0 = StateV0.safeParse(raw)
    if (v0.success) return { ...INITIAL_STATE, folds: v0.data.folds }
  }
  return undefined
}
