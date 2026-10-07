import { ClaimService } from './claim-service';
import { PaymentLedger } from '../domain/payment-ledger';
export class PaymentService {
  constructor(private readonly claims: ClaimService, private readonly ledger: PaymentLedger) {}
  settle(claimId: string, input: { amount: number; currency: string; sourceId: string; partyId?: string }, actor: string) {
    const claim = this.claims.get(claimId); if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');
    const alreadyPaid = this.ledger.balance(claim.payments); const amountMinor = Math.round(input.amount * 100);
    const latest = claim.adjustments.at(-1);
    const claimCap = latest ? latest.result.totals.insurerBorneMinor : claim.approvedMinor;
    if (alreadyPaid + amountMinor > claimCap) throw new Error(`payment exceeds approved amount (paid ${alreadyPaid} + ${amountMinor} > approved ${claimCap})`);
    if (input.partyId) {
      const partyLine = latest?.result.parties.find((party) => party.partyId === input.partyId);
      if (!partyLine) throw new Error(`payment party ${input.partyId} is not part of the latest adjustment`);
      const partyPaid = claim.payments
        .filter((entry) => entry.status === 'posted' && entry.partyId === input.partyId)
        .reduce((sum, entry) => sum + entry.amount.minor, 0);
      if (partyPaid + amountMinor > partyLine.insurerBorneMinor) {
        throw new Error(`payment exceeds party ${input.partyId} insurer share (${partyPaid} + ${amountMinor} > ${partyLine.insurerBorneMinor})`);
      }
    }
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'settlement' });
    return this.claims.addEvent(claimId, 'payment.settled', { payment }, actor, `payment:${input.sourceId}`);
  }
  reverse(claimId: string, input: { amount: number; currency: string; sourceId: string; partyId?: string }, actor: string) {
    const claim = this.claims.get(claimId); const payment = this.ledger.post(claim.payments, { ...input, kind: 'reversal' });
    return this.claims.addEvent(claimId, 'payment.reversed', { payment }, actor, `reversal:${input.sourceId}`);
  }
}
