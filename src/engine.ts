/**
 * `CarryOnCompactionEngine`: dsh's basic compaction backend with CarryOn's fold as its summarizer.
 *
 * `BasicCompactionEngine` keeps the trigger policy, the verbatim tail, the lock bracket, tool-pair-safe edges, shrink
 * validation and token accounting; `summarize()` is its documented subclass hook (design doc §4). Each call runs one
 * CarryOn fold (`src/fold.ts`): the checkpoint text replaces the shadowed region and the new state goes into
 * `rawOutput`, where the session projection picks it up once dsh reports the compaction as successful.
 *
 * A rejected fold changes nothing (§3.3): `summarize()` throws and dsh leaves the surface as it was. Rescans then
 * back off as in the paper's BrowseComp-Plus setting (Appendix A.3, "Runtime triggering"): after k consecutive
 * failures the next scan waits for `rescanTokens · 2^min(k, maxBackoffDoublings)` new tokens, and calls in between
 * fail without a model call. Safety net (not in the paper): when the context is at `fallbackRatio` of the window or
 * above, a failed or cooling-down fold falls back to dsh's own summary, prefixed with the current CarryOn
 * checkpoint, so the session can continue; carriers and execution context stay unchanged.
 *
 * @module dsh-carryon/engine
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { interactionMessages, runFold, tailTokens, type ScanMemory } from './fold.ts'
import { addUsage, dshRoleCall, RoleLLM, type RoleTarget } from './llm.ts'
import { carryOnProjectionDefinition, type CarryOnProjectionState } from './projection.ts'
import { Compiler, Tracker } from './roles.ts'
import { encodeState, type CarryOnState, type TextBlock } from './state.ts'
import { renderCheckpoint, type ViewMessage } from './view.ts'

/** Provider name recorded when no role call was made. */
export const PROVIDER = 'dsh-carryon'

/** Set to `1` to make every CarryOn fold fail (before any model call), to check that a failed fold changes nothing. */
export const FAIL_ENV = 'DSH_CARRYON_FAIL'

/** Structural copy of dsh-compaction-basic's (unexported) `SummarizationInput`. */
export interface SummarizationInput {
  readonly tools?: readonly unknown[]
  readonly messages: readonly unknown[]
}

/** Structural copy of the unmarked `SummaryResult` variant: two role calls, not one `ctx.llm.stream()` call. */
export interface CarryOnSummaryResult {
  summary: TextBlock[]
  provider: string
  model: string
  rawOutput: TextBlock[]
  usage?: TokenUsage
}

/** Structural copy of dsh-compaction-basic's (unexported) `SummaryResult`, for the fallback's result. */
export type SummaryResultLike = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & ({ rawOutput: ContentBlock[]; llmStreamCall: true } | { rawOutput?: ContentBlock[]; llmStreamCall?: never })

/** CarryOn settings, accepted next to the basic backend's keys on the `carryon-compaction` row. */
export interface CarryOnConfig {
  /** Model for the Tracker and Compiler; both or neither. Default: the session's routed model. */
  runtimeProvider?: string
  runtimeModel?: string
  /** Output cap of each role call. */
  runtimeMaxTokens?: number
  /** Compile requests the Tracker may make per scan (paper: 4). */
  maxRequestsPerScan?: number
  /** New-token threshold before a rescan after a failed fold (paper, OSWorld: 6,000). */
  rescanTokens?: number
  /** Cap on the threshold doublings after consecutive failures (paper, BrowseComp-Plus: 6). */
  maxBackoffDoublings?: number
  /** Context share (of the window) from which a failed fold falls back to dsh's summary. */
  fallbackRatio?: number
}

const DEFAULTS: Required<Omit<CarryOnConfig, 'runtimeProvider' | 'runtimeModel'>> = {
  runtimeMaxTokens: 8192,
  maxRequestsPerScan: 4,
  rescanTokens: 6000,
  maxBackoffDoublings: 6,
  fallbackRatio: 0.95,
}

const CARRYON_KEYS = ['runtimeProvider', 'runtimeModel', ...Object.keys(DEFAULTS)] as const

type BasicConfig = NonNullable<ConstructorParameters<typeof BasicCompactionEngine>[1]>

/** A fold that did not commit. Thrown from `summarize()`, so dsh records a failed compaction. */
export class CarryOnFoldError extends Error {
  override name = 'CarryOnFoldError'
}

/** Per-session process memory: backoff and what failed folds left (design doc §4.1: lost on resume). */
export interface SessionMemory {
  nextStep: number
  failures: number
  tokensAtLastScan: number
  scan: ScanMemory | undefined
}

/**
 * Backoff after failed folds (Appendix A.3): after k consecutive failures, the next scan waits until the region's
 * interaction text has grown by `rescanTokens · 2^min(k, maxBackoffDoublings)` tokens since the last scan.
 * @param memory - the session's failures and token count at the last scan.
 * @param tokens - estimated tokens of the current region's interaction messages.
 * @returns why to skip this scan, or `null` to scan now.
 */
export function cooldown(
  memory: Pick<SessionMemory, 'failures' | 'tokensAtLastScan'>,
  tokens: number,
  config: Pick<CarryOnConfig, 'rescanTokens' | 'maxBackoffDoublings'> & { rescanTokens: number; maxBackoffDoublings: number },
): string | null {
  if (memory.failures === 0) return null
  const needed = config.rescanTokens * 2 ** Math.min(memory.failures, config.maxBackoffDoublings)
  const grown = tokens - memory.tokensAtLastScan
  return grown >= needed ? null : `cooling down after ${memory.failures} failed fold(s): ${grown} of ${needed} new tokens`
}

/**
 * Split the row's config into CarryOn keys and the basic backend's keys (which rejects unknown keys).
 * @returns both halves, CarryOn defaults applied.
 */
export function splitConfig(config: BasicConfig & CarryOnConfig): {
  carryon: Required<Omit<CarryOnConfig, 'runtimeProvider' | 'runtimeModel'>> & Pick<CarryOnConfig, 'runtimeProvider' | 'runtimeModel'>
  basic: BasicConfig
} {
  const basic: Record<string, unknown> = {}
  const own: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) ((CARRYON_KEYS as readonly string[]).includes(k) ? own : basic)[k] = v
  const carryon = { ...DEFAULTS, ...own } as ReturnType<typeof splitConfig>['carryon']
  if ((carryon.runtimeProvider === undefined) !== (carryon.runtimeModel === undefined)) {
    throw new Error('dsh-carryon: runtimeProvider and runtimeModel must be set together')
  }
  if (!(carryon.fallbackRatio > 0 && carryon.fallbackRatio <= 1)) throw new Error('dsh-carryon: fallbackRatio must be in (0, 1]')
  return { carryon, basic: { ...basic, compactionRetries: (basic as BasicConfig).compactionRetries ?? 0 } as BasicConfig }
}

/** Compaction service (`ctx.compaction`) whose summaries are CarryOn folds. */
export class CarryOnCompactionEngine extends BasicCompactionEngine {
  static override inject = [...BasicCompactionEngine.inject, 'sessionProjections']

  readonly carryon: ReturnType<typeof splitConfig>['carryon']
  private projection!: ProjectionHandle<CarryOnProjectionState>
  private readonly memory = new Map<string, SessionMemory>()

  /**
   * Accepts the basic backend's keys plus {@link CarryOnConfig}. `compactionRetries` defaults to 0: a retry
   * re-selects a smaller range, often only the previous checkpoint, which a CarryOn fold cannot shrink (§4.3).
   */
  constructor(ctx: Context, config: BasicConfig & CarryOnConfig = {}) {
    const { carryon, basic } = splitConfig(config)
    super(ctx, basic)
    this.carryon = carryon
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(carryOnProjectionDefinition)
  }

  /**
   * Committed CarryOn state of a session, rebuilt from its log.
   * @returns the state after the last successful CarryOn fold.
   */
  stateOf(agent: Pick<Agent, 'session'>): CarryOnState {
    return this.projection.stateOf(agent.session).committed
  }

  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CarryOnSummaryResult | SummaryResultLike> {
    signal?.throwIfAborted()
    const state = this.stateOf(agent)
    const tail = interactionMessages(input.messages as readonly ViewMessage[])
    const tokens = tailTokens(tail)
    const memory = this.memoryFor(String(agent.session.id), state.next_step)

    const waiting = cooldown(memory, tokens, this.carryon)
    if (waiting !== null) return this.failOrFallback(input, agent, signal, state, memory, waiting)

    const target = this.roleTarget(agent)
    const call = dshRoleCall(this.ctx, target, { sessionId: agent.session.id, maxTokens: this.carryon.runtimeMaxTokens })
    const tracker = new Tracker(new RoleLLM(call), this.carryon.maxRequestsPerScan)
    const compiler = new Compiler(new RoleLLM(call))
    const outcome = process.env[FAIL_ENV] === '1'
      ? { ok: false as const, reason: `failed on purpose (${FAIL_ENV}=1)`, memory: memory.scan }
      : await runFold({ state, tail, memory: memory.scan, tracker, compiler, ...signal === undefined ? {} : { signal } })
    const usage = addUsage(tracker.llm.usage.usage, compiler.llm.usage.usage)

    if (outcome.ok) {
      this.memory.delete(String(agent.session.id))
      this.ctx.logger.info(`dsh-carryon: fold ${outcome.state.folds} committed (${outcome.carrierIds.join(', ')})`)
      const result: CarryOnSummaryResult = {
        summary: [{ type: 'text', text: outcome.checkpoint }],
        provider: target.provider,
        model: target.model,
        rawOutput: [encodeState(outcome.state)],
      }
      if (usage.inputTokens + usage.outputTokens > 0) result.usage = usage
      return result
    }
    memory.failures += 1
    memory.tokensAtLastScan = tokens
    memory.scan = outcome.memory
    return this.failOrFallback(input, agent, signal, state, memory, `fold rejected: ${outcome.reason}`)
  }

  /**
   * Throw (the fold fails, nothing changes) unless the context is near the window, in which case summarize with
   * dsh's basic summarizer and keep the current CarryOn checkpoint in front of it.
   */
  private async failOrFallback(
    input: SummarizationInput,
    agent: Agent,
    signal: AbortSignal | undefined,
    state: CarryOnState,
    memory: SessionMemory,
    reason: string,
  ): Promise<SummaryResultLike> {
    if (!(await this.nearWindow(agent, signal))) throw new CarryOnFoldError(`dsh-carryon: ${reason}`)
    this.ctx.logger.warn(`dsh-carryon: ${reason}; context is near the window, falling back to dsh's summary`)
    // @ts-expect-error SummarizationInput here is a structural copy; dsh hands summarize() its own input unchanged.
    const result: SummaryResultLike = await super.summarize(input, agent, signal)
    // The region is now summarized; the next scan starts over on what remains.
    memory.tokensAtLastScan = 0
    memory.scan = undefined
    const checkpoint = renderCheckpoint(state.carriers, state.ec)
    if (checkpoint === null) return result
    return { ...result, summary: [{ type: 'text' as const, text: checkpoint }, ...result.summary] }
  }

  /** True when the session's latest request is at `fallbackRatio` of its model's window or above. */
  private async nearWindow(agent: Agent, signal?: AbortSignal): Promise<boolean> {
    const header = agent.session.requestHeader()
    if (header === undefined) return false
    const info = await this.ctx.llm.resolveModelInfo(header.config.provider, header.config.model, signal)
    const window = info.context?.contextWindow
    if (window === undefined || window <= 0) return false
    const used = this.ctx.tokenMeter.measure(agent.session, header).totalTokens
    return used >= this.carryon.fallbackRatio * window
  }

  /** Model for the runtime roles: configured, else the session's routed model, else the agent's options. */
  private roleTarget(agent: Agent): RoleTarget {
    const { runtimeProvider, runtimeModel } = this.carryon
    if (runtimeProvider && runtimeModel) return { provider: runtimeProvider, model: runtimeModel }
    const routed = agent.session.requestHeader()?.config
    if (routed?.provider && routed.model) return { provider: routed.provider, model: routed.model }
    if (agent.options.provider && agent.options.model) return { provider: agent.options.provider, model: agent.options.model }
    throw new CarryOnFoldError('dsh-carryon: no model for the runtime roles; set runtimeProvider and runtimeModel')
  }

  private memoryFor(sessionId: string, nextStep: number): SessionMemory {
    const existing = this.memory.get(sessionId)
    if (existing?.nextStep === nextStep) return existing
    const fresh: SessionMemory = { nextStep, failures: 0, tokensAtLastScan: 0, scan: undefined }
    this.memory.set(sessionId, fresh)
    return fresh
  }
}

export default CarryOnCompactionEngine
