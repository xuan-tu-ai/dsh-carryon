/**
 * JSON-output model calls for the runtime roles (Tracker, Compiler), over dsh's `ctx.llm.stream()` (design doc
 * §4.4). Port of carrycode `src/carrycode/llm.py`: one retry on invalid JSON or a schema violation, then give up.
 *
 * @module dsh-carryon/llm
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { z } from 'zod'

const FENCE = /^\s*```[A-Za-z0-9_-]*\s*\n([\s\S]*?)\n?\s*```\s*$/

/**
 * Remove one Markdown code fence around a reply; some models fence JSON even when asked not to.
 * @returns the fenced body, or `text` unchanged when it is not exactly one fenced block.
 */
export function stripCodeFence(text: string): string {
  return FENCE.exec(text)?.[1] ?? text
}

/** One user turn of a role conversation. */
export interface RoleTurn {
  role: 'user' | 'assistant'
  text: string
}

/** A model reply and its provider-reported usage. */
export interface RoleReply {
  text: string
  usage?: TokenUsage
}

/** One model call: system prompt plus conversation, returns the reply text. Throws on transport errors. */
export type RoleCall = (system: string, turns: readonly RoleTurn[], signal?: AbortSignal) => Promise<RoleReply>

/** Usage counters of one role, reported with the fold. */
export interface RoleUsage {
  calls: number
  usage: TokenUsage
  /** Why replies were rejected (truncated), oldest first. */
  failures: string[]
}

/**
 * Sum two token usages field by field.
 * @returns a new usage object.
 */
export function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (b === undefined) return a
  const sum: TokenUsage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
  for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    if (a[key] !== undefined || b[key] !== undefined) sum[key] = (a[key] ?? 0) + (b[key] ?? 0)
  }
  return sum
}

/** One runtime role bound to one model. Counts usage so the runtime's overhead can be reported. */
export class RoleLLM {
  readonly usage: RoleUsage = { calls: 0, usage: { inputTokens: 0, outputTokens: 0 }, failures: [] }

  private readonly call: RoleCall
  private readonly maxRetries: number

  constructor(call: RoleCall, maxRetries = 1) {
    this.call = call
    this.maxRetries = maxRetries
  }

  /**
   * Ask for a JSON object matching `schema`.
   * @returns the parsed object, or `null` after `maxRetries + 1` invalid replies.
   * @throws when the model call itself fails (transport error, abort).
   */
  async completeJson<S extends z.ZodType>(
    system: string,
    user: string,
    schema: S,
    signal?: AbortSignal,
  ): Promise<z.output<S> | null> {
    const turns: RoleTurn[] = [{ role: 'user', text: user }]
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      signal?.throwIfAborted()
      const reply = await this.call(system, turns, signal)
      this.usage.calls += 1
      this.usage.usage = addUsage(this.usage.usage, reply.usage)
      let problem: string
      try {
        const parsed = schema.safeParse(JSON.parse(stripCodeFence(reply.text)))
        if (parsed.success) return parsed.data
        problem = parsed.error.message
      } catch (e) {
        problem = e instanceof Error ? e.message : String(e)
      }
      this.usage.failures.push(problem.slice(0, 300))
      turns.push(
        { role: 'assistant', text: reply.text },
        { role: 'user', text: `Invalid output: ${problem}. Reply with corrected JSON only.` },
      )
    }
    return null
  }
}

/** A provider/model pair for the runtime roles. */
export interface RoleTarget {
  provider: string
  model: string
}

/**
 * A `RoleCall` over `ctx.llm.stream()`. dsh request messages need durable ids for assistant turns, so a retry
 * conversation is flattened into one user message that quotes the rejected reply.
 * @param ctx - context providing the LLM service.
 * @param target - model for the roles.
 * @param options - session id (for attribution) and output cap.
 * @returns the call.
 */
export function dshRoleCall(
  ctx: Context,
  target: RoleTarget,
  options: { sessionId?: GenerateOptions['sessionId']; maxTokens?: number },
): RoleCall {
  return async (system, turns, signal) => {
    const text = turns.map((t, i) =>
      i === 0 ? t.text : t.role === 'assistant' ? `# Your previous reply\n${t.text}` : `# Problem\n${t.text}`,
    ).join('\n\n')
    const request: GenerateOptions = {
      provider: target.provider,
      model: target.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      purpose: 'compaction',
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
      ...signal === undefined ? {} : { signal },
    }
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    const reply = assembler.blocks()
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
    return assembler.usage === undefined ? { text: reply } : { text: reply, usage: assembler.usage }
  }
}
