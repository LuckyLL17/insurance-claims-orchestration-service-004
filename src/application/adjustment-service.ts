import { EventStore } from './event-store';
import { ClaimService } from './claim-service';
import { calculateAdjustment, defaultPartyInputs, diffAdjustments } from '../domain/adjustment';
import { AdjustmentPartyInput, AdjustmentResult, AdjustmentTrial, ClaimState } from '../domain/types';

export interface TrialRequest {
  /** Major currency units (e.g. CNY yuan); converted to integer minor units. */
  grossLoss?: number;
  /** Explicit minor-unit override of the gross loss; wins over grossLoss. */
  grossLossMinor?: number;
  parties?: AdjustmentPartyInput[];
  reason?: string;
}

export class AdjustmentService {
  constructor(private readonly events: EventStore, private readonly claims: ClaimService) {}

  /**
   * Run a payout trial and append an immutable `adjustment.trialed` event.
   * Prior trials are never overwritten or truncated; every difference vs the
   * previous retained version is recorded with its source on the new result.
   */
  trial(claimId: string, request: TrialRequest, actor: string, key?: string): ClaimState {
    const claim = this.claims.get(claimId);
    const previous = claim.adjustments.at(-1);

    const grossLossMinor = this.resolveGrossMinor(request, claim);
    const requested = request.parties ?? defaultPartyInputs(claim.loss, claim.policy, this.priorPaidMap(claim));
    const parties = requested.map((party) => ({
      ...party,
      priorPaidMinor: party.priorPaidMinor ?? this.priorPaidFor(party.partyId, claim),
    }));

    const baseResult = calculateAdjustment({ currency: claim.loss.currency, grossLossMinor, parties, reason: request.reason });
    const trigger = previous ? this.detectTrigger(previous.result, baseResult, request) : 'initial';
    const result: AdjustmentResult = previous
      ? { ...baseResult, changes: diffAdjustments(previous.result, baseResult) }
      : baseResult;

    const payload: TrialPayload = {
      actor,
      trigger,
      source: trigger === 'liability_change' ? 'liability' : trigger === 'manual_readjustment' ? 'manual' : trigger === 'initial' ? 'initial' : 'recompute',
      basedOnVersion: previous?.version,
      result,
    };
    this.events.append(claimId, 'adjustment.trialed', payload, actor, key);
    return this.claims.get(claimId);
  }

  private resolveGrossMinor(request: TrialRequest, claim: ClaimState): number {
    if (request.grossLossMinor !== undefined) {
      if (!Number.isInteger(request.grossLossMinor) || request.grossLossMinor < 0) throw new Error('grossLossMinor must be a non-negative integer');
      return request.grossLossMinor;
    }
    const gross = request.grossLoss ?? claim.loss.gross;
    if (typeof gross !== 'number' || !Number.isFinite(gross) || gross < 0) throw new Error('grossLoss must be a non-negative finite number');
    return Math.round(gross * 100);
  }

  private priorPaidMap(claim: ClaimState): Map<string, number> {
    const map = new Map<string, number>();
    for (const entry of claim.payments) {
      if (entry.status !== 'posted' || entry.partyId === undefined) continue;
      map.set(entry.partyId, (map.get(entry.partyId) ?? 0) + entry.amount.minor);
    }
    return map;
  }

  private priorPaidFor(partyId: string, claim: ClaimState): number {
    const attributed = claim.payments
      .filter((entry) => entry.status === 'posted' && entry.partyId === partyId)
      .reduce((sum, entry) => sum + entry.amount.minor, 0);
    if (attributed !== 0) return attributed;
    // Legacy payments predating per-party attribution fall onto the single
    // default `self` party; with multiple parties they stay unallocated but are
    // still guarded by the claim-level payment cap.
    const structured = claim.loss.liabilityParties;
    const hasUnallocated = claim.payments.some((entry) => entry.status === 'posted' && entry.partyId === undefined);
    if (hasUnallocated && (!structured || !structured.length) && partyId === 'self') {
      return claim.payments.filter((entry) => entry.status === 'posted' && entry.partyId === undefined).reduce((sum, entry) => sum + entry.amount.minor, 0);
    }
    return 0;
  }

  private detectTrigger(previous: AdjustmentResult, next: AdjustmentResult, request: TrialRequest): AdjustmentTrial['trigger'] {
    if (request.parties?.some((party) => party.manualInsurerMinor !== undefined)) return 'manual_readjustment';
    const prevById = new Map(previous.parties.map((p) => [p.partyId, p]));
    const shareChanged = next.parties.some((p) => prevById.get(p.partyId)?.share !== p.share) || previous.parties.length !== next.parties.length;
    if (shareChanged) return 'liability_change';
    return 'recompute';
  }
}

interface TrialPayload {
  actor: string;
  trigger: AdjustmentTrial['trigger'];
  source: AdjustmentTrial['source'];
  basedOnVersion?: number;
  result: AdjustmentResult;
}
