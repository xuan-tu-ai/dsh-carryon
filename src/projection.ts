/**
 * Session projection that restores CarryOn state from the session log.
 *
 * dsh forbids new synchronous reads of Session history (`snapshotEvents`, `eventAt`, `ownEvents`); state that
 * must survive resume is rebuilt by a projection unit that the framework drives over committed events. This
 * unit commits the state found in a `compaction/summary.rawOutput` only when the matching `compaction/end`
 * reports success, so a failed fold changes nothing (carrycode hard rule; design doc §4.1).
 *
 * @module dsh-carryon/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-compaction'
import { decodeState, INITIAL_STATE, STATE_VERSION, type CarryOnState } from './state.ts'

/** Projection key owned by this plugin. */
export const PROJECTION_KEY = 'carryon'

/** Projection state: the committed CarryOn state plus a fold in progress, if any. */
export interface CarryOnProjectionState {
  readonly committed: CarryOnState
  /** State written by a `compaction/summary` whose `compaction/end` has not been seen yet. */
  readonly pending: { readonly compactionId: string; readonly state: CarryOnState } | null
}

const carryOnStateSchema = z.object({
  v: z.literal(STATE_VERSION),
  folds: z.number().int().nonnegative(),
})

const projectionStateSchema: z.ZodType<CarryOnProjectionState> = z.object({
  committed: carryOnStateSchema,
  pending: z.object({ compactionId: z.string(), state: carryOnStateSchema }).nullable(),
})

/**
 * Pure fold over committed session events.
 * @param state - state covering all prior events.
 * @param event - next committed event.
 * @returns the next state; the same reference when the event does not concern CarryOn.
 */
export function applyCarryOnProjection(state: CarryOnProjectionState, event: SessionEvent): CarryOnProjectionState {
  if (event.type === 'compaction/summary') {
    const written = decodeState(event.data.rawOutput)
    // A summary from another backend (or a failed decode) clears any stale pending fold but keeps committed state.
    if (written === undefined) return state.pending === null ? state : { ...state, pending: null }
    return { ...state, pending: { compactionId: String(event.data.compactionId), state: written } }
  }
  if (event.type === 'compaction/end') {
    if (state.pending === null || state.pending.compactionId !== String(event.data.compactionId)) return state
    if (event.data.error !== undefined) return { ...state, pending: null }
    return { committed: state.pending.state, pending: null }
  }
  return state
}

/** The projection unit registered with `ctx.sessionProjections` (host-only: no client view). */
export const carryOnProjectionDefinition = {
  key: PROJECTION_KEY,
  stateSchema: projectionStateSchema,
  init: (): CarryOnProjectionState => ({ committed: INITIAL_STATE, pending: null }),
  apply: applyCarryOnProjection,
  stateVersion: 0,
} satisfies ProjectionDefinition<typeof PROJECTION_KEY, CarryOnProjectionState>
