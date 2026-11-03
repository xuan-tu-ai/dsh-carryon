/**
 * Validation before commit (§3.3, "Validation and Commitment").
 *
 * These checks guard the runtime against inconsistent updates; they do not verify task correctness. Port of
 * carrycode `src/carrycode/validator.py`. The problem strings are the same as carrycode's, and the parity fixtures
 * `test/fixtures/parity/validator.json` compare them.
 *
 * @module dsh-carryon/validator
 */

import { arrayEquals, claimEquals, type CompilerOutput, type EvidencePackage } from './records.ts'
import { makeCarrierId, type CarrierStore } from './registry.ts'

/**
 * Check a Compiler output against its evidence package and the committed carriers.
 * @returns the problems found, in a fixed order; an empty list means the fold may be committed.
 */
export function validate(output: CompilerOutput, pkg: EvidencePackage, store: CarrierStore): string[] {
  const problems: string[] = []
  if (output.abstain_reason) problems.push(`compiler abstained: ${output.abstain_reason}`)
  if (output.carrier_edits.length === 0) problems.push('a fold must change at least one carrier')

  const selected = new Set(pkg.candidates.map((c) => c.candidate_id))
  const allowedSteps = new Set(Object.keys(pkg.evidence).map(Number))
  const seen = new Set<string>()

  for (const edit of output.carrier_edits) {
    const cid = edit.carrier_id ?? makeCarrierId(edit.carrier_type, edit.subject)

    if (!selected.has(edit.candidate_id)) problems.push(`${cid}: candidate ${edit.candidate_id} was not selected`)

    if (seen.has(cid)) problems.push(`${cid}: edited twice in one fold`)
    else seen.add(cid)

    if (edit.carrier_id === null) {
      if (store.get(cid) !== undefined) {
        problems.push(`${cid}: carrier exists; an update must set carrier_id and base_version`)
      }
      if (edit.base_version !== null) problems.push(`${cid}: a new carrier must not set base_version`)
    } else {
      const current = store.get(cid)
      if (current === undefined) {
        problems.push(`${cid}: unknown carrier`)
      } else if (makeCarrierId(edit.carrier_type, edit.subject) !== cid) {
        // Identity is stable across versions (App. A.1): an update may not move the carrier.
        problems.push(`${cid}: an update must keep the carrier's type and subject`)
      } else if (edit.base_version !== current.version) {
        problems.push(`${cid}: stale base_version ${edit.base_version ?? 'None'} (current v${current.version})`)
      } else if (
        edit.summary === current.summary
        && arrayEquals(edit.conditions, current.conditions)
        && edit.claims.length === current.claims.length
        && edit.claims.every((c, i) => claimEquals(c, current.claims[i]!))
      ) {
        problems.push(`${cid}: edit does not change the carrier`)
      }
    }

    for (const claim of edit.claims) {
      const unauthorized = [...new Set(claim.source_steps)].filter((s) => !allowedSteps.has(s)).sort((a, b) => a - b)
      if (unauthorized.length > 0) {
        problems.push(`${cid}/${claim.claim_id}: cites unauthorized steps [${unauthorized.join(', ')}]`)
      }
    }
  }

  // TODO(carrycode M2): check that every object-bound edit has a supported Grounder verdict in pkg.check_results.
  return problems
}
