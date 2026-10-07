import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { calculateAdjustment } from '../src/domain/adjustment';

test('creates a claim with a historical policy snapshot and replays it', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'mobile', participants: [{ kind: 'vehicle', id: 'car-1' }], loss: { currency: 'CNY', gross: 18000 } }, 'test', 'claim-key');
  assert.equal(claim.policy?.version, 2);
  const evidence = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'a' } }, 'test');
  const reviewed = app.claims.reviewEvidence(claim.id, evidence.evidence[0].id, true, 'adjuster');
  assert.equal(reviewed.evidence[0].accepted, true);
  assert.equal(app.replay.execute(claim.id).state.version, reviewed.version);
});

test('prevents payment over approved amount and accepts idempotent risk assessment', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [{ kind: 'vehicle', id: 'car-2' }, { kind: 'repair_shop', id: 'shop-1' }], loss: { currency: 'CNY', gross: 18000 } }, 'test');
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: 'photo' }, 'test');
  const assessed = app.risks.assess(claim.id, 'risk');
  assert.equal(assessed.riskScore, 0);
  assert.throws(() => app.payments.settle(claim.id, { amount: 1, currency: 'CNY', sourceId: 'p-1' }, 'pay'), /exceeds approved/);
});

test('rejects stale task submissions after lease version changes', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [], loss: { currency: 'CNY', gross: 3000 } }, 'test');
  const task = app.tasks.create(claim.id, 'survey'); const lease = app.tasks.lease(claim.id, task.id, 'adjuster-a', 60_000);
  assert.throws(() => app.tasks.submit(claim.id, task.id, 'adjuster-a', lease.version - 1, {}, 'adjuster-a'), /stale/);
});

test('allocates indivisible minor units, deductibles and party caps without losing a cent', () => {
  const trial = calculateAdjustment({
    currency: 'CNY',
    grossMinor: 10_001,
    deductibleMinor: 100,
    parties: [
      { id: 'car-a', liabilityShare: 1 },
      { id: 'car-b', liabilityShare: 1 },
      { id: 'car-c', liabilityShare: 1, capMinor: 2_000 },
    ],
  });

  assert.deepEqual(trial.parties.map((party) => party.grossMinor), [3_334, 3_334, 3_333]);
  assert.deepEqual(trial.parties.map((party) => party.deductibleAppliedMinor), [34, 33, 33]);
  assert.deepEqual(trial.parties.map((party) => party.insurerMinor), [3_300, 3_301, 2_000]);
  assert.equal(trial.partyCapExcessMinor, 1_300);
  assert.equal(trial.approvedMinor, 8_601);
  assert.equal(trial.roundingResidualMinor, 0);
  assert.equal(trial.deductibleAppliedMinor + trial.partyCapExcessMinor + trial.approvedMinor, trial.grossMinor);
});

test('applies one party deductible across multiple loss items instead of deducting it per item', () => {
  const trial = calculateAdjustment({
    currency: 'CNY',
    grossMinor: 10_000,
    parties: [{ id: 'car-a', liabilityShare: 1, deductibleMinor: 1_000 }],
    items: [{ id: 'repair', grossMinor: 6_000 }, { id: 'property', grossMinor: 4_000 }],
  });

  assert.equal(trial.deductibleAppliedMinor, 1_000);
  assert.equal(trial.approvedMinor, 9_000);
  assert.deepEqual(trial.items.map((item) => item.deductibleAppliedMinor), [600, 400]);
});

test('applies item and aggregate caps in order while preserving party and item totals', () => {
  const trial = calculateAdjustment({
    currency: 'CNY',
    grossMinor: 10_000,
    capMinor: 5_000,
    parties: [{ id: 'car-a', liabilityShare: 1 }, { id: 'car-b', liabilityShare: 1 }],
    items: [
      { id: 'repair', grossMinor: 6_000, capMinor: 2_000 },
      { id: 'property', grossMinor: 4_000 },
    ],
  });

  assert.equal(trial.approvedMinor, 5_000);
  assert.equal(trial.itemCapExcessMinor, 4_000);
  assert.equal(trial.globalCapExcessMinor, 1_000);
  assert.deepEqual(trial.parties.map((party) => [party.grossMinor, party.insurerMinor]), [[5_000, 2_500], [5_000, 2_500]]);
  assert.deepEqual(trial.items.map((item) => [item.grossMinor, item.insurerMinor]), [[6_000, 1_666], [4_000, 3_334]]);
  assert.equal(trial.items[0].insurerMinor + trial.items[1].insurerMinor, trial.approvedMinor);
});

test('keeps the original adjustment and identifies sources when liability is recalculated after payment', () => {
  const app = buildApp();
  const parties = [
    { kind: 'vehicle' as const, id: 'car-a' },
    { kind: 'vehicle' as const, id: 'car-b' },
    { kind: 'vehicle' as const, id: 'car-c' },
  ];
  const claim = app.claims.create({
    policyId: 'P-100',
    lossAt: '2026-08-01T08:00:00Z',
    reportedAt: '2026-08-01T09:00:00Z',
    channel: 'agent',
    participants: parties,
    loss: {
      currency: 'CNY',
      gross: 1000.01,
      parties: [
        { id: 'car-a', liabilityShare: 1 },
        { id: 'car-b', liabilityShare: 1 },
        { id: 'car-c', liabilityShare: 1 },
      ],
    },
  }, 'test');
  const evidence = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: 'photo' }, 'test');
  app.claims.reviewEvidence(claim.id, evidence.evidence[0].id, true, 'test');

  const first = app.claims.approveAdjustment(claim.id, {}, 'adjuster-a');
  const firstRecord = first.adjustments[0];
  app.payments.settle(claim.id, { amount: 500, currency: 'CNY', sourceId: 'pay-1' }, 'pay');
  const revised = app.claims.approveAdjustment(claim.id, {
    parties: [
      { id: 'car-a', liabilityShare: 1 },
      { id: 'car-b', liabilityShare: 4 },
      { id: 'car-c', liabilityShare: 5 },
    ],
  }, 'adjuster-b', undefined, 'police report revised fault');

  assert.equal(revised.adjustments.length, 2);
  assert.equal(revised.adjustments[0].id, firstRecord.id);
  assert.equal(revised.adjustments[0].approvedMinor, firstRecord.approvedMinor);
  assert.equal(revised.adjustments[1].previousAdjustmentId, firstRecord.id);
  assert.ok(revised.adjustments[1].differences.some((difference) => difference.code === 'liability-share-changed' && difference.partyId === 'car-b'));
  assert.ok(revised.adjustments[1].differences.some((difference) => difference.code === 'payment-overpaid'));
  assert.equal(revised.adjustments[1].overpaidMinor, 11_667);
  assert.equal(revised.status, 'reopened');

  app.payments.reverse(claim.id, { amount: 116.67, currency: 'CNY', sourceId: 'recovery-1' }, 'pay');
  app.payments.settle(claim.id, { amount: 116.68, currency: 'CNY', sourceId: 'pay-2' }, 'pay');
  const settled = app.claims.get(claim.id);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.adjustments.at(-1)?.paidMinor, settled.approvedMinor);
  assert.equal(settled.adjustments.at(-1)?.overpaidMinor, 0);
  for (const party of settled.adjustments.at(-1)?.parties ?? []) {
    assert.equal(party.paidMinor, party.insurerMinor);
    assert.equal(party.outstandingMinor, 0);
  }
});

test('rejects a sub-minor adjustment amount instead of silently truncating it', () => {
  assert.throws(() => calculateAdjustment({ gross: 10.005, parties: [{ id: 'car-a' }] }), /minimum currency unit/);
});
