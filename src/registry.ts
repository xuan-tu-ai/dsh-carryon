/**
 * Candidate registry and versioned carrier store (Appendix A.1).
 *
 * Port of carrycode `src/carrycode/registry.py`; the parity fixtures `test/fixtures/parity/registry.json` pin
 * its behaviour, error messages included.
 *
 * @module dsh-carryon/registry
 */

import { posixNormpath, pySplit, pyStrip } from './pystr.ts'
import type { Candidate, CarrierEdit, CarrierRecord, CarrierType } from './records.ts'

/**
 * Stable carrier identity from type and normalized subject (App. A.1).
 *
 * `external_object`: strip whitespace, drop a leading `/testbed/` or `./`, then POSIX-normalize the path.
 * Other types: collapse runs of whitespace to one space and strip.
 * @returns `${carrierType}:${normalized}`.
 */
export function makeCarrierId(carrierType: CarrierType, subject: string): string {
  let normalized: string
  if (carrierType === 'external_object') {
    let s = pyStrip(subject)
    if (s.startsWith('/testbed/')) s = s.slice('/testbed/'.length)
    else if (s.startsWith('./')) s = s.slice(2)
    normalized = posixNormpath(s)
  } else {
    normalized = pySplit(subject).join(' ')
  }
  return `${carrierType}:${normalized}`
}

/** A rejected commit. Nothing was written. */
export class CarrierStoreError extends Error {
  override name = 'CarrierStoreError'
}

/** Keeps every carrier version. The latest version of each carrier is the current one. */
export class CarrierStore {
  /** carrier id → versions, oldest first; insertion order is first-commit order. */
  private readonly versions = new Map<string, CarrierRecord[]>()

  /** @returns the current version of every carrier, in first-commit order. */
  current(): CarrierRecord[] {
    return [...this.versions.values()].map((v) => v.at(-1)!)
  }

  /** @returns the current version of `carrierId`, if the carrier exists. */
  get(carrierId: string): CarrierRecord | undefined {
    return this.versions.get(carrierId)?.at(-1)
  }

  /** @returns every committed version of `carrierId`, oldest first. */
  history(carrierId: string): CarrierRecord[] {
    return [...(this.versions.get(carrierId) ?? [])]
  }

  /**
   * Turn Compiler edits into records: version 1 for new carriers, current + 1 (predecessor = current) for
   * updates. Does not change the store.
   * @param edits - edits from one fold, already validated.
   * @param foldNumber - the fold that commits them.
   */
  materialize(edits: readonly CarrierEdit[], foldNumber: number): CarrierRecord[] {
    return edits.map((edit) => {
      const carrierId = edit.carrier_id ?? makeCarrierId(edit.carrier_type, edit.subject)
      const current = this.get(carrierId)
      return {
        carrier_id: carrierId,
        version: current === undefined ? 1 : current.version + 1,
        predecessor_version: current === undefined ? null : current.version,
        carrier_type: edit.carrier_type,
        subject: edit.subject,
        summary: edit.summary,
        conditions: [...edit.conditions],
        claims: edit.claims.map((c) => ({ ...c, source_steps: [...c.source_steps], evidence_refs: [...c.evidence_refs] })),
        committed_at_fold: foldNumber,
      }
    })
  }

  /**
   * Commit records atomically: validate all first, then write all. A new carrier id must be version 1 with no
   * predecessor; an existing one must be exactly current version + 1 and name the current version as its
   * predecessor.
   * @throws {CarrierStoreError} when any record breaks the version chain; the store is unchanged.
   */
  apply(records: readonly CarrierRecord[]): void {
    for (const r of records) {
      const existing = this.get(r.carrier_id)
      if (existing === undefined) {
        if (r.version !== 1 || r.predecessor_version !== null) {
          throw new CarrierStoreError(`new carrier ${r.carrier_id} must start at version 1`)
        }
      } else if (r.version !== existing.version + 1 || r.predecessor_version !== existing.version) {
        throw new CarrierStoreError(
          `carrier ${r.carrier_id}: expected successor of v${existing.version}, `
          + `got v${r.version} (predecessor ${r.predecessor_version ?? 'None'})`,
        )
      }
    }
    for (const r of records) {
      const versions = this.versions.get(r.carrier_id)
      if (versions) versions.push(r)
      else this.versions.set(r.carrier_id, [r])
    }
  }
}

/** Tracks candidates across Tracker invocations. Registering one never triggers a fold. */
export class CandidateRegistry {
  private readonly candidates = new Map<string, Candidate>()

  /** Add a candidate or replace the one with the same id (keeping its position). */
  upsert(candidate: Candidate): void {
    this.candidates.set(candidate.candidate_id, candidate)
  }

  get(candidateId: string): Candidate | undefined {
    return this.candidates.get(candidateId)
  }

  /** @returns all candidates, in first-registration order. */
  all(): Candidate[] {
    return [...this.candidates.values()]
  }

  remove(candidateId: string): void {
    this.candidates.delete(candidateId)
  }
}
