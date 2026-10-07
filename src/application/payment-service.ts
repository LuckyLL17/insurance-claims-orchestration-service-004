import { ClaimService } from './claim-service';
import { PaymentLedger } from '../domain/payment-ledger';
import { AdjustmentRecord } from '../domain/types';
import { allocateLargestRemainder } from '../domain/adjustment';

interface PaymentInput {
  amount: number;
  currency: string;
  sourceId: string;
  allocations?: Array<{ partyId: string; minor?: number; amount?: number }>;
}
type PaymentAllocations = Array<{ partyId: string; minor: number }>;

export class PaymentService {
  constructor(private readonly claims: ClaimService, private readonly ledger: PaymentLedger) {}

  private currentAdjustment(claimId: string): AdjustmentRecord | undefined {
    const claim = this.claims.get(claimId);
    const adjustment = claim.adjustments.find((record) => record.id === claim.currentAdjustmentId);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');
    return adjustment;
  }

  private normalizeSettlementAllocations(input: PaymentInput, amountMinor: number, adjustment: AdjustmentRecord): PaymentAllocations {
    if (!input.allocations) {
      if (amountMinor > adjustment.outstandingMinor) throw new Error('payment exceeds approved amount');
      const amounts = allocateLargestRemainder(amountMinor, adjustment.parties.map((party) => party.outstandingMinor), input.sourceId);
      return adjustment.parties.map((party, index) => ({ partyId: party.partyId, minor: amounts[index] })).filter((allocation) => allocation.minor !== 0);
    }
    const allocations = this.normalizeExplicitAllocations(input, amountMinor, adjustment);
    for (const allocation of allocations) {
      const party = adjustment.parties.find((candidate) => candidate.partyId === allocation.partyId);
      if (allocation.minor > (party?.outstandingMinor ?? 0)) throw new Error(`payment exceeds approved amount for party ${allocation.partyId}`);
    }
    return allocations;
  }

  private normalizeReversalAllocations(input: PaymentInput, amountMinor: number, adjustment: AdjustmentRecord): PaymentAllocations {
    if (input.allocations) {
      const allocations = this.normalizeExplicitAllocations(input, amountMinor, adjustment);
      for (const allocation of allocations) {
        const party = adjustment.parties.find((candidate) => candidate.partyId === allocation.partyId);
        if (allocation.minor > (party?.paidMinor ?? 0)) throw new Error(`reversal exceeds posted payment for party ${allocation.partyId}`);
      }
      return allocations;
    }

    const amounts = new Map(adjustment.parties.map((party) => [party.partyId, 0]));
    let remaining = amountMinor;
    for (const party of adjustment.parties) {
      const recovered = Math.min(remaining, party.overpaidMinor);
      amounts.set(party.partyId, recovered);
      remaining -= recovered;
    }
    if (remaining > 0) {
      const recoverable = adjustment.parties.map((party) => party.paidMinor - party.overpaidMinor);
      const additional = allocateLargestRemainder(remaining, recoverable, input.sourceId);
      adjustment.parties.forEach((party, index) => amounts.set(party.partyId, (amounts.get(party.partyId) ?? 0) + additional[index]));
    }
    return [...amounts.entries()].map(([partyId, minor]) => ({ partyId, minor })).filter((allocation) => allocation.minor !== 0);
  }

  private normalizeExplicitAllocations(input: PaymentInput, amountMinor: number, adjustment: AdjustmentRecord): PaymentAllocations {
    const allocations = (input.allocations ?? []).map((allocation) => {
      const minor = allocation.minor ?? Math.round((allocation.amount ?? 0) * 100);
      if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error(`payment allocation for ${allocation.partyId} must be a positive integer minor amount`);
      return { partyId: allocation.partyId, minor };
    });
    if (allocations.reduce((sum, allocation) => sum + allocation.minor, 0) !== amountMinor) throw new Error('payment allocations must equal the payment amount');
    const knownParties = new Set(adjustment.parties.map((party) => party.partyId));
    for (const allocation of allocations) {
      if (!knownParties.has(allocation.partyId)) throw new Error(`payment allocation references unknown party: ${allocation.partyId}`);
    }
    return allocations;
  }

  settle(claimId: string, input: PaymentInput, actor: string) {
    const claim = this.claims.get(claimId);
    const adjustment = this.currentAdjustment(claimId);
    if (adjustment && input.currency !== adjustment.currency) throw new Error('payment currency must match adjustment currency');
    const amountMinor = Math.round(input.amount * 100);
    const alreadyPaid = this.ledger.balance(claim.payments);
    const approvedMinor = adjustment?.approvedMinor ?? claim.approvedMinor;
    if (adjustment && adjustment.overpaidMinor > 0) throw new Error('recover overpaid party amounts before making another payment');
    if (alreadyPaid + amountMinor > approvedMinor) throw new Error('payment exceeds approved amount');
    const allocations = adjustment ? this.normalizeSettlementAllocations(input, amountMinor, adjustment) : undefined;
    const payment = this.ledger.post(claim.payments, { ...input, allocations, kind: 'settlement' });
    return this.claims.addEvent(claimId, 'payment.settled', { payment }, actor, `payment:${input.sourceId}`);
  }

  reverse(claimId: string, input: PaymentInput, actor: string) {
    const claim = this.claims.get(claimId);
    const adjustment = this.currentAdjustment(claimId);
    if (adjustment && input.currency !== adjustment.currency) throw new Error('reversal currency must match adjustment currency');
    const amountMinor = Math.round(input.amount * 100);
    const paid = this.ledger.balance(claim.payments);
    if (amountMinor > paid) throw new Error('reversal exceeds posted payment amount');
    const allocations = adjustment ? this.normalizeReversalAllocations(input, amountMinor, adjustment) : undefined;
    const payment = this.ledger.post(claim.payments, { ...input, allocations, kind: 'reversal' });
    return this.claims.addEvent(claimId, 'payment.reversed', { payment }, actor, `reversal:${input.sourceId}`);
  }
}
