import { PaymentEntry } from './types';
import { asMinor, newId, iso } from './ids';

export interface PostPaymentInput {
  kind: PaymentEntry['kind'];
  amount: number;
  currency: string;
  sourceId: string;
  allocations?: Array<{ partyId: string; minor?: number; amount?: number }>;
}

export class PaymentLedger {
  post(entries: PaymentEntry[], input: PostPaymentInput): PaymentEntry {
    if (entries.some((entry) => entry.sourceId === input.sourceId && entry.kind === input.kind)) throw new Error(`duplicate payment source ${input.sourceId}`);
    const amount = asMinor(input.amount);
    if (amount === 0) throw new Error('payment amount must be positive');
    const signedAmount = input.kind === 'reversal' || input.kind === 'recovery' ? -amount : amount;
    const allocations = input.allocations?.length
      ? input.allocations.map((allocation) => {
        if (allocation.minor !== undefined && allocation.amount !== undefined) throw new Error(`payment allocation for ${allocation.partyId} cannot use major and minor units together`);
        const minor = allocation.minor ?? Math.round((allocation.amount ?? 0) * 100);
        return { partyId: allocation.partyId, minor };
      })
      : undefined;
    if (allocations) {
      if (allocations.some((allocation) => !Number.isSafeInteger(allocation.minor) || allocation.minor <= 0 || !allocation.partyId)) throw new Error('payment allocations must be positive integer minor amounts with a partyId');
      const total = allocations.reduce((sum, allocation) => sum + allocation.minor, 0);
      if (total !== amount) throw new Error('payment allocations must equal the payment amount');
      const seen = new Set<string>();
      for (const allocation of allocations) {
        if (seen.has(allocation.partyId)) throw new Error(`duplicate payment allocation for ${allocation.partyId}`);
        seen.add(allocation.partyId);
      }
    }
    return {
      id: newId('payment'),
      kind: input.kind,
      amount: { currency: input.currency, minor: signedAmount },
      allocations: allocations?.map((allocation) => ({ partyId: allocation.partyId, minor: signedAmount < 0 ? -allocation.minor : allocation.minor })),
      sourceId: input.sourceId,
      status: 'posted',
      createdAt: iso(),
    };
  }

  balance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }
  settlementBalance(entries: PaymentEntry[]): number { return entries.filter((entry) => entry.kind === 'settlement' && entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0); }
  partyBalances(entries: PaymentEntry[]): Map<string, number> {
    const balances = new Map<string, number>();
    for (const entry of entries.filter((payment) => payment.status === 'posted')) {
      for (const allocation of entry.allocations ?? []) balances.set(allocation.partyId, (balances.get(allocation.partyId) ?? 0) + allocation.minor);
    }
    return balances;
  }
}
