import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { calculateAdjustment } from '../src/domain/adjustment';

function createClaim(gross = 10000, share?: number) {
  const app = buildApp();
  const claim = app.claims.create(
    {
      policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent',
      participants: [{ kind: 'vehicle', id: 'car-1' }, { kind: 'vehicle', id: 'car-2' }],
      loss: { currency: 'CNY', gross, ...(share === undefined ? {} : { liabilityShare: share }) },
    },
    'test',
  );
  return { app, claim };
}

test('multi-party apportionment conserves the gross loss to the last minor unit', () => {
  // 33.33/33.33/33.34 of 10000.00 -> shares alone cannot reproduce the total;
  // the largest-remainder residual must be assigned exactly once.
  const result = calculateAdjustment({
    currency: 'CNY',
    grossLossMinor: 1_000_000,
    parties: [
      { partyId: 'a', share: 1 / 3 },
      { partyId: 'b', share: 1 / 3 },
      { partyId: 'c', share: 1 / 3 },
    ],
  });
  const apportioned = result.parties.map((p) => p.apportionedMinor);
  assert.deepEqual(apportioned.sort((x, y) => x - y), [333_333, 333_333, 333_334]);
  assert.equal(apportioned.reduce((s, v) => s + v, 0), 1_000_000);
  assert.equal(result.conservation.liabilityResidualMinor, 1);
  assert.equal(result.conservation.apportionedTotalMinor, 1_000_000);
  assert.equal(result.conservation.balanced, true);
  // no party receives a negative or above-gross amount
  assert.ok(result.parties.every((p) => p.apportionedMinor >= 0 && p.apportionedMinor <= 1_000_000));
});

test('deductible is absorbed only up to the apportioned share and never produces negatives', () => {
  const result = calculateAdjustment({
    currency: 'CNY',
    grossLossMinor: 10_000,
    parties: [
      { partyId: 'a', share: 0.1, deductibleMinor: 50_000, capMinor: 1_000_000 },
      { partyId: 'b', share: 0.9 },
    ],
  });
  const a = result.parties[0];
  assert.equal(a.apportionedMinor, 1_000);
  assert.equal(a.deductibleAppliedMinor, 1_000);
  assert.equal(a.deductibleUnabsorbedMinor, 49_000);
  assert.equal(a.afterDeductibleMinor, 0);
  assert.equal(a.insurerBorneMinor, 0);
  assert.equal(a.retainedMinor, 1_000);
  assert.ok(result.parties.every((p) => p.insurerBorneMinor >= 0 && p.retainedMinor >= 0));
  assert.equal(result.conservation.insurerBorneTotalMinor + result.conservation.retainedTotalMinor, 10_000);
});

test('cap overflow stays attributed to the capped party instead of being truncated', () => {
  const result = calculateAdjustment({
    currency: 'CNY',
    grossLossMinor: 100_000,
    parties: [
      { partyId: 'a', share: 0.8, deductibleMinor: 0, capMinor: 20_000 },
      { partyId: 'b', share: 0.2 },
    ],
  });
  const a = result.parties[0];
  const b = result.parties[1];
  assert.equal(a.apportionedMinor, 80_000);
  assert.equal(a.capOverflowMinor, 60_000);
  assert.equal(a.insurerBorneMinor, 20_000);
  assert.equal(a.retainedMinor, 60_000);
  // overflow must not leak into the other party
  assert.equal(b.apportionedMinor, 20_000);
  assert.equal(b.insurerBorneMinor, 20_000);
  assert.ok(a.insurerBorneMinor <= (a.capMinor ?? Infinity));
});

test('every conservation identity holds for a full ordered trial', () => {
  const result = calculateAdjustment({
    currency: 'CNY',
    grossLossMinor: 12_345,
    parties: [
      { partyId: 'a', share: 0.37, deductibleMinor: 500, capMinor: 3_000, priorPaidMinor: 200 },
      { partyId: 'b', share: 0.42, deductibleMinor: 0, capMinor: 100_000 },
      { partyId: 'c', share: 0.21, deductibleMinor: 99_999 },
    ],
  });
  assert.equal(
    result.parties.reduce((s, p) => s + p.apportionedMinor, 0),
    12_345,
  );
  for (const p of result.parties) assert.equal(p.insurerBorneMinor + p.retainedMinor, p.apportionedMinor);
  assert.equal(result.conservation.insurerBorneTotalMinor + result.conservation.retainedTotalMinor, 12_345);
  assert.equal(
    result.totals.additionalPayableMinor - result.totals.overpaidMinor,
    result.totals.insurerBorneMinor - result.totals.priorPaidMinor,
  );
  assert.ok(result.conservation.identities.every((label) => !/= -|exceeds/.test(label)));
});

test('rejects liability shares that do not sum to one instead of silently normalizing', () => {
  assert.throws(
    () => calculateAdjustment({ currency: 'CNY', grossLossMinor: 1000, parties: [{ partyId: 'a', share: 0.6 }, { partyId: 'b', share: 0.3 }] }),
    /shares must sum to 1/,
  );
});

test('liability change preserves the original trial and records every difference source', () => {
  const { app, claim } = createClaim(10_000);
  const first = app.adjustments.trial(claim.id, {
    parties: [
      { partyId: 'a', share: 0.7, deductibleMinor: 500, capMinor: 1_000_000 },
      { partyId: 'b', share: 0.3 },
    ],
  }, 'adjuster');
  assert.equal(first.adjustments.length, 1);
  assert.equal(first.adjustments[0].version, 1);

  const second = app.adjustments.trial(claim.id, {
    parties: [
      { partyId: 'a', share: 0.4, deductibleMinor: 500, capMinor: 1_000_000 },
      { partyId: 'b', share: 0.6 },
    ],
  }, 'adjuster');
  assert.equal(second.adjustments.length, 2);
  // original result is retained verbatim
  assert.equal(second.adjustments[0].result.parties[0].apportionedMinor, 700_000);
  assert.equal(second.adjustments[1].version, 2);
  assert.equal(second.adjustments[1].basedOnVersion, 1);
  assert.equal(second.adjustments[1].trigger, 'liability_change');
  const codes = second.adjustments[1].result.changes.map((c) => c.code);
  assert.ok(codes.includes('LIABILITY_SHARE_CHANGED'));
  // the change record carries both apportioned amounts as the difference source
  const shareChange = second.adjustments[1].result.changes.find((c) => c.code === 'LIABILITY_SHARE_CHANGED' && c.partyId === 'a')!;
  assert.equal(shareChange.fromMinor, 700_000);
  assert.equal(shareChange.toMinor, 400_000);
  // totals still conserved after the change (10,000.00 yuan = 1,000,000 minor)
  const latest = second.adjustments[1].result;
  assert.equal(latest.parties.reduce((s, p) => s + p.apportionedMinor, 0), 1_000_000);
});

test('manual re-adjustment keeps the auto result, the delta and an audit reason', () => {
  const { app, claim } = createClaim(10_000);
  app.adjustments.trial(claim.id, { parties: [{ partyId: 'a', share: 1, deductibleMinor: 0 }] }, 'adjuster');
  assert.throws(
    () => app.adjustments.trial(claim.id, { parties: [{ partyId: 'a', share: 1, deductibleMinor: 0, manualInsurerMinor: 800_000 }] }, 'adjuster'),
    /manualReason is required/,
  );
  const state = app.adjustments.trial(claim.id, {
    parties: [{ partyId: 'a', share: 1, deductibleMinor: 0, manualInsurerMinor: 800_000, manualReason: 'goodwill reduction negotiated with insured' }],
  }, 'adjuster');
  const latest = state.adjustments.at(-1)!;
  assert.equal(latest.trigger, 'manual_readjustment');
  const line = latest.result.parties[0];
  assert.equal(line.autoInsurerMinor, 1_000_000);
  assert.equal(line.manualInsurerMinor, 800_000);
  assert.equal(line.manualDeltaMinor, -200_000);
  assert.equal(line.insurerBorneMinor, 800_000);
  // the 2000 reduction is retained by the insured, not lost
  assert.equal(line.retainedMinor, 200_000);
  assert.equal(latest.result.conservation.insurerBorneTotalMinor + latest.result.conservation.retainedTotalMinor, 1_000_000);
  assert.ok(latest.result.changes.some((c) => c.code === 'MANUAL_OVERRIDE_CHANGED'));
  // manual amount above the apportioned share is rejected
  assert.throws(
    () => app.adjustments.trial(claim.id, { parties: [{ partyId: 'a', share: 1, manualInsurerMinor: 1_000_001, manualReason: 'x' }] }, 'adjuster'),
    /exceeds apportioned loss/,
  );
  assert.throws(
    () => app.adjustments.trial(claim.id, { parties: [{ partyId: 'a', share: 1, deductibleMinor: 0, capMinor: 500_000, manualInsurerMinor: 600_000, manualReason: 'x' }] }, 'adjuster'),
    /exceeds responsibility cap/,
  );
});

test('already-paid amounts offset net payable; overpayment is surfaced not hidden', () => {
  const { app, claim } = createClaim(10_000);
  app.adjustments.trial(claim.id, { parties: [{ partyId: 'a', share: 1, deductibleMinor: 0 }] }, 'adjuster');
  app.payments.settle(claim.id, { amount: 9000, currency: 'CNY', sourceId: 'p-1', partyId: 'a' }, 'pay');
  const state = app.adjustments.trial(claim.id, {
    parties: [{ partyId: 'a', share: 1, deductibleMinor: 200_000 }],
  }, 'adjuster');
  const line = state.adjustments.at(-1)!.result.parties[0];
  // insurer share dropped to 8000.00 while 9000.00 was already paid
  assert.equal(line.insurerBorneMinor, 800_000);
  assert.equal(line.priorPaidMinor, 900_000);
  assert.equal(line.additionalPayableMinor, 0);
  assert.equal(line.overpaidMinor, 100_000);
  assert.ok(state.adjustments.at(-1)!.result.changes.some((c) => c.code === 'PRIOR_PAYMENT_OFFSET'));
  assert.equal(state.approvedMinor, 800_000);
});

test('payment is capped both at claim level and per responsible party', () => {
  const { app, claim } = createClaim(10_000);
  const state = app.adjustments.trial(claim.id, {
    parties: [
      { partyId: 'a', share: 0.7, deductibleMinor: 500 },
      { partyId: 'b', share: 0.3 },
    ],
  }, 'adjuster');
  const aLine = state.adjustments.at(-1)!.result.parties.find((p) => p.partyId === 'a')!;
  assert.throws(
    () => app.payments.settle(claim.id, { amount: aLine.insurerBorneMinor / 100 + 1, currency: 'CNY', sourceId: 'p-x', partyId: 'a' }, 'pay'),
    /exceeds party a insurer share/,
  );
  app.payments.settle(claim.id, { amount: aLine.insurerBorneMinor / 100, currency: 'CNY', sourceId: 'p-a', partyId: 'a' }, 'pay');
  assert.throws(
    () => app.payments.settle(claim.id, { amount: 1, currency: 'CNY', sourceId: 'p-a2', partyId: 'a' }, 'pay'),
    /exceeds party a insurer share/,
  );
});

test('default single-party trial applies deductible before cap and fixes the inverted share math', () => {
  const { app, claim } = createClaim(18_000, 0.5);
  const state = app.adjustments.trial(claim.id, {}, 'adjuster');
  const result = state.adjustments.at(-1)!.result;
  const self = result.parties.find((p) => p.partyId === 'self')!;
  const counter = result.parties.find((p) => p.partyId === 'counterparty')!;
  // gross 18,000.00 CNY = 1,800,000 minor; own policy deductible is 500.00 = 50,000 minor
  assert.equal(self.apportionedMinor, 900_000);
  assert.equal(counter.apportionedMinor, 900_000);
  assert.equal(self.insurerBorneMinor, 850_000);
  assert.equal(self.retainedMinor, 50_000);
  // the at-fault third party's share is retained by it, not paid by this insurer
  assert.equal(counter.insurerBorneMinor, 0);
  assert.equal(counter.retainedMinor, 900_000);
  assert.equal(result.totals.insurerBorneMinor, 850_000);
  assert.equal(result.totals.insurerBorneMinor + result.totals.retainedMinor, 1_800_000);
  // approvedMinor is the own-policy insurer share only
  assert.equal(state.approvedMinor, 850_000);
});

test('rule engine quick evaluation is conserved after the fix', () => {
  const { app, claim } = createClaim(18_000, 0.5);
  const decision = app.rules.evaluate(app.claims.get(claim.id), app.claims.get(claim.id).ruleSnapshot!);
  assert.equal(decision.approvedMinor, 850_000);
  assert.ok(decision.reasons.some((r) => r === 'calculation:conserved=true'));
  // old formula gross*(1+(1-share)) = 27,000 > gross would have failed this:
  assert.ok(decision.approvedMinor <= 1_800_000);
});

test('combined shares, deductibles, sub-limits and residuals never break conservation', () => {
  // Three responsible subjects: own insurer side (deductible + sub-limit),
  // another covered insurer subject (own sub-limit), and an uninsured third.
  const result = calculateAdjustment({
    currency: 'CNY',
    grossLossMinor: 33_333.37 * 100 | 0, // deliberately odd cents
    parties: [
      { partyId: 'self', role: 'insured', insuredCovered: true, share: 0.45, deductibleMinor: 80_000, capMinor: 1_000_000 },
      { partyId: 'other-insured', role: 'insured', insuredCovered: true, share: 0.25, deductibleMinor: 0, capMinor: 500_000 },
      { partyId: 'third', role: 'third_party', insuredCovered: false, share: 0.30 },
    ],
  });
  const gross = result.grossLossMinor;
  assert.equal(result.parties.reduce((s, p) => s + p.apportionedMinor, 0), gross);
  for (const p of result.parties) {
    assert.equal(p.insurerBorneMinor + p.retainedMinor, p.apportionedMinor);
    assert.ok(p.insurerBorneMinor >= 0);
    if (p.insuredCovered && p.capMinor !== null) assert.ok(p.insurerBorneMinor <= p.capMinor);
  }
  assert.equal(result.totals.insurerBorneMinor + result.totals.retainedMinor, gross);
  assert.equal(result.conservation.liabilityResidualMinor + result.parties.reduce((s, p) => s + p.floorMinor, 0), gross);
  // third party never contributes to insurer payable
  assert.equal(result.parties.find((p) => p.partyId === 'third')!.insurerBorneMinor, 0);
});

test('trial history survives replay and approved amount derives from latest trial', () => {
  const { app, claim } = createClaim(10_000);
  app.adjustments.trial(claim.id, { parties: [{ partyId: 'a', share: 1 }] }, 'adjuster', 'trial-1');
  app.adjustments.trial(claim.id, { parties: [{ partyId: 'a', share: 0.6 }, { partyId: 'b', share: 0.4 }] }, 'adjuster', 'trial-2');
  const replay = app.replay.execute(claim.id);
  assert.equal(replay.state.adjustments.length, 2);
  assert.equal(replay.state.adjustments[0].result.parties.length, 1);
  assert.equal(replay.state.adjustments[1].result.parties.length, 2);
  assert.equal(replay.state.approvedMinor, replay.state.adjustments.at(-1)!.result.totals.insurerBorneMinor);
});
