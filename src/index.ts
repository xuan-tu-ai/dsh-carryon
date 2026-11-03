/**
 * dsh-carryon: CarryOn context folding (arXiv:2610.18784) as a DeepSeek Harness compaction backend.
 *
 * The bundle's `cordis.patch.yml` mounts {@link CarryOnCompactionEngine} as `ctx.compaction` in place of
 * `@deepseek-ai/dsh-compaction-basic`. The CarryOn core (records, registry, validator, view) is ported from carrycode
 * and checked against its parity fixtures; the engine does not use it yet (P2).
 *
 * @module dsh-carryon
 */

export { CarryOnCompactionEngine, renderP0Checkpoint, FAIL_ENV, P0_MODEL, P0_PROVIDER } from './engine.ts'
export type { CarryOnSummaryResult, SummarizationInput } from './engine.ts'
export { applyCarryOnProjection, carryOnProjectionDefinition, PROJECTION_KEY } from './projection.ts'
export type { CarryOnProjectionState } from './projection.ts'
export { decodeState, encodeState, INITIAL_STATE, STATE_KEY, STATE_VERSION } from './state.ts'
export type { CarryOnState } from './state.ts'
export * from './records.ts'
export * from './registry.ts'
export * from './validator.ts'
export * from './view.ts'
export { CarryOnCompactionEngine as default } from './engine.ts'
