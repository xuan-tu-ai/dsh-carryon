/**
 * Data models of the context view: candidates, versioned carrier records, claims and the execution context
 * (paper §3.2 and Appendix A.1), plus the Compiler input and output the Validator checks (§3.3, Eq. 2).
 *
 * Port of carrycode `src/carrycode/records.py` (and the `EvidencePackage` / `CompilerOutput` models of
 * `compiler.py`, `CheckResult` of `grounder/base.py`). Field names are the same JSON names as the pydantic
 * models, so state and fixtures are shared between the two runtimes (design doc §5). Defaults match pydantic's:
 * a missing list is `[]`, a missing optional value is `null`; unknown keys are dropped.
 *
 * @module dsh-carryon/records
 */

import { z } from 'zod'

/** The three carrier forms of §3.2. */
export const CarrierType = z.enum(['external_object', 'information_product', 'situated_state'])
export type CarrierType = z.output<typeof CarrierType>

/**
 * An integer, also accepted as a decimal string or a float with no fractional part, as pydantic's lax mode does:
 * models often quote step numbers.
 */
export const Int = z.preprocess(
  (v) => (typeof v === 'string' && /^\s*[-+]?\d+\s*$/.test(v) ? Number(v) : v),
  z.number().int(),
)

/** Log step indices. JSON keys of `EvidencePackage.evidence` are their decimal strings. */
const Steps = z.array(Int).default([])
const Strings = z.array(z.string()).default([])

/** One proposition inside an information product (Appendix A.1). */
export const Claim = z.object({
  claim_id: z.string(),
  proposition: z.string(),
  value: z.string().nullable().default(null),
  /** Indices into the interaction log that support this claim. */
  source_steps: Steps,
  /** Coding evidence, e.g. "src/foo.py:42" or "pytest tests/test_x.py::test_y". */
  evidence_refs: Strings,
  retracted: z.boolean().default(false),
})
export type Claim = z.output<typeof Claim>

/** A committed carrier version. Updates create a successor with the same `carrier_id`. */
export const CarrierRecord = z.object({
  carrier_id: z.string(),
  version: Int.default(1),
  predecessor_version: Int.nullable().default(null),
  carrier_type: CarrierType,
  /** Stable identity: a normalized file path, or a structured subject for findings/state. */
  subject: z.string(),
  /** The reusable progress this carrier holds. */
  summary: z.string(),
  /** Conditions under which the progress can be reused. */
  conditions: Strings,
  /** Only for information products. */
  claims: z.array(Claim).default([]),
  committed_at_fold: Int,
})
export type CarrierRecord = z.output<typeof CarrierRecord>

/** A carrier change proposed by the Compiler (§3.3 Eq. 2, ΔA_t). The runtime turns it into a `CarrierRecord`. */
export const CarrierEdit = z.object({
  /** The selected candidate this edit compiles. */
  candidate_id: z.string(),
  /** `null` for a new carrier (the id is derived from type + subject); set to update an existing carrier. */
  carrier_id: z.string().nullable().default(null),
  /** For updates: the current version this edit was based on. Must be `null` for new carriers. */
  base_version: Int.nullable().default(null),
  carrier_type: CarrierType,
  subject: z.string(),
  summary: z.string(),
  conditions: Strings,
  claims: z.array(Claim).default([]),
})
export type CarrierEdit = z.output<typeof CarrierEdit>

/** Progress that may become a carrier (Appendix A.1, "Candidate Records"). */
export const Candidate = z.object({
  candidate_id: z.string(),
  provisional_type: CarrierType,
  subject: z.string(),
  description: z.string(),
  supporting_steps: Steps,
  /** Set when the candidate updates an existing carrier. */
  target_carrier_id: z.string().nullable().default(null),
  first_seen_step: Int,
  last_revised_step: Int,
})
export type Candidate = z.output<typeof Candidate>

/** An open duty the agent still owes (deliverable, unperformed step, ...). */
export const Obligation = z.object({
  obligation_id: z.string(),
  text: z.string(),
  source_steps: Steps,
  resolved: z.boolean().default(false),
})
export type Obligation = z.output<typeof Obligation>

/** Information needed to continue that carriers do not capture (§3.2). */
export const ExecutionContext = z.object({
  current_focus: Strings,
  active_constraints: Strings,
  obligations: z.array(Obligation).default([]),
  immediate_continuation: Strings,
})
export type ExecutionContext = z.output<typeof ExecutionContext>

/**
 * Obligations not yet resolved.
 * @param ec - execution context.
 * @returns its open obligations, in order.
 */
export function openObligations(ec: ExecutionContext): Obligation[] {
  return ec.obligations.filter((o) => !o.resolved)
}

/** Grounder verdicts (Appendix A.2). */
export const Verdict = z.enum(['supported', 'contradicted', 'unknown'])
export type Verdict = z.output<typeof Verdict>

/** Result of one read-only environment check. */
export const CheckResult = z.object({
  check_name: z.string(),
  /** What was checked, e.g. a file path or a test id. */
  target: z.string(),
  verdict: Verdict,
  /** What the check saw (truncated command output, hash, ...). Kept as provenance. */
  observation: z.string(),
})
export type CheckResult = z.output<typeof CheckResult>

/** U_t: everything a compilation is allowed to rely on, frozen before the Compiler runs (§3.3). */
export const EvidencePackage = z.object({
  candidates: z.array(Candidate),
  prior_records: z.array(CarrierRecord).default([]),
  /** Log step (decimal string, as in JSON) → authorized text of that step. */
  evidence: z.record(z.string().regex(/^-?\d+$/), z.string()).default({}),
  check_results: z.array(CheckResult).default([]),
})
export type EvidencePackage = z.output<typeof EvidencePackage>

/** The Compiler's answer: carrier edits and the revised execution context (§3.3, Eq. 2). */
export const CompilerOutput = z.object({
  carrier_edits: z.array(CarrierEdit).default([]),
  execution_context: ExecutionContext,
  /** Set when an honest replacement for the live tail cannot be built. */
  abstain_reason: z.string().nullable().default(null),
})
export type CompilerOutput = z.output<typeof CompilerOutput>

/**
 * Field-wise equality of two claims, as pydantic's `==` compares models.
 * @returns true when every field is equal.
 */
export function claimEquals(a: Claim, b: Claim): boolean {
  return a.claim_id === b.claim_id
    && a.proposition === b.proposition
    && a.value === b.value
    && arrayEquals(a.source_steps, b.source_steps)
    && arrayEquals(a.evidence_refs, b.evidence_refs)
    && a.retracted === b.retracted
}

/**
 * Element-wise equality of two arrays of primitives.
 * @returns true when both have the same length and equal elements in order.
 */
export function arrayEquals<T extends string | number | boolean>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
