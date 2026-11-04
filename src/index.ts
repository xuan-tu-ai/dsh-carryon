/**
 * dsh-carryon: CarryOn context folding (arXiv:2610.18784) as a DeepSeek Harness compaction backend.
 *
 * The bundle's `cordis.patch.yml` mounts {@link CarryOnCompactionEngine} as `ctx.compaction` in place of
 * `@deepseek-ai/dsh-compaction-basic`. The CarryOn core (records, registry, validator, view) is ported from carrycode
 * and checked against its parity fixtures; each compaction runs one CarryOn fold over it (P2).
 *
 * @module dsh-carryon
 */

export { CarryOnCompactionEngine, CarryOnFoldError, cooldown, FAIL_ENV, PROVIDER, splitConfig } from './engine.ts'
export type { CarryOnConfig, CarryOnSummaryResult, SessionMemory, SummarizationInput } from './engine.ts'
export { applyCarryOnProjection, carryOnProjectionDefinition, PROJECTION_KEY } from './projection.ts'
export type { CarryOnProjectionState } from './projection.ts'
export { CarryOnState, decodeState, encodeState, INITIAL_STATE, STATE_KEY, STATE_VERSION } from './state.ts'
export * from './fold.ts'
export * from './llm.ts'
export * from './roles.ts'
export * from './records.ts'
export * from './registry.ts'
export * from './validator.ts'
export * from './view.ts'
export { CarryOnCompactionEngine as default } from './engine.ts'
