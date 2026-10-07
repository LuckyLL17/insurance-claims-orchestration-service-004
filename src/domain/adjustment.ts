import { AdjustmentChange, AdjustmentConservation, AdjustmentPartyInput, AdjustmentPartyLine, AdjustmentResult, AdjustmentTrial, AdjustmentTrialInput, LiabilityParty, LossEstimate, PolicyVersion } from './types';

/**
 * Liability shares are accepted as fractions and immediately scaled to this
 * integer basis. All downstream apportionment is done with BigInt so that no
 * float artefact can create or destroy minor currency units.
 */
export const SHARE_SCALE = 1_000_000;
const SHARE_SUM_TOLERANCE = 1e-6;

function nonNegInteger(value: number | undefined, name: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || !Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative integer (minor units), got ${String(value)}`);
  }
  return resolved;
}

/**
 * Pure, deterministic payout trial calculation.
 *
 * Mandatory order (do not reorder):
 *   1. liability apportionment of the gross loss (largest-remainder, integer minor units)
 *   2. deductible deduction per responsible party (never produces negatives)
 *   3. per-party cap clipping (overflow is classified, never truncated or redistributed)
 *   4. minimum-currency-unit residuals are assigned once, to largest fractional remainders
 *   5. already-paid amounts are offset last, surfacing overpayments instead of hiding them
 *
 * Every minor unit is accounted for: apportioned = insurerBorne + retained, and
 * sum(apportioned) === grossLoss. See the returned `conservation` block.
 */
export function calculateAdjustment(input: AdjustmentTrialInput): AdjustmentResult {
  if (!input.currency) throw new Error('adjustment currency is required');
  const grossMinor = nonNegInteger(input.grossLossMinor, 'grossLossMinor', NaN);
  if (!Array.isArray(input.parties) || input.parties.length === 0) throw new Error('adjustment requires at least one responsible party');

  const seen = new Set<string>();
  let shareSum = 0;
  for (const party of input.parties) {
    if (!party.partyId) throw new Error('every responsible party requires a partyId');
    if (seen.has(party.partyId)) throw new Error(`duplicate responsible party: ${party.partyId}`);
    seen.add(party.partyId);
    if (typeof party.share !== 'number' || !Number.isFinite(party.share) || party.share < 0) {
      throw new Error(`party ${party.partyId}: share must be a finite non-negative number`);
    }
    shareSum += party.share;
  }
  if (Math.abs(shareSum - 1) > SHARE_SUM_TOLERANCE) {
    throw new Error(`liability shares must sum to 1.0, got ${shareSum}`);
  }

  const scaled = input.parties.map((party) => BigInt(Math.round(party.share * SHARE_SCALE)));
  const scaledTotal = scaled.reduce((acc, value) => acc + value, 0n);
  if (scaledTotal === 0n) throw new Error('liability shares are all zero, cannot apportion loss');

  // Step 1: integer apportionment with a largest-remainder residual pass.
  const gross = BigInt(grossMinor);
  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  let floorTotal = 0;
  for (const s of scaled) {
    const product = gross * s;
    floors.push(product / scaledTotal);
    remainders.push(product % scaledTotal);
    floorTotal += Number(product / scaledTotal);
  }
  const residualUnits = grossMinor - floorTotal;
  if (residualUnits < 0 || residualUnits > input.parties.length) {
    throw new Error(`liability residual out of range: ${residualUnits}`);
  }
  const residualOrder = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => (a.remainder < b.remainder ? 1 : a.remainder > b.remainder ? -1 : a.index - b.index))
    .slice(0, residualUnits)
    .map((entry) => entry.index);
  const residualSet = new Set(residualOrder);

  let insurerTotal = 0;
  let retainedTotal = 0;
  let priorPaidTotal = 0;
  let additionalPayableTotal = 0;
  let overpaidTotal = 0;

  const parties: AdjustmentPartyLine[] = input.parties.map((party, index) => {
    const floorMinor = Number(floors[index]);
    const residualReceived = residualSet.has(index) ? 1 : 0;
    const apportionedMinor = floorMinor + residualReceived;

    // Step 2: deductible is absorbed only up to the loss actually apportioned;
    // a deductible can never drive a party's share below zero.
    const deductibleMinor = nonNegInteger(party.deductibleMinor, `party ${party.partyId}: deductibleMinor`, 0);
    const deductibleAppliedMinor = Math.min(deductibleMinor, apportionedMinor);
    const deductibleUnabsorbedMinor = Math.max(0, deductibleMinor - apportionedMinor);
    const afterDeductibleMinor = apportionedMinor - deductibleAppliedMinor;

    // Step 3: cap clipping. Overflow remains explicitly attributed to this
    // party (self-retention); it is never silently dropped nor pushed onto
    // another party's insurer.
    let capMinor: number | null = null;
    if (party.capMinor !== undefined) capMinor = nonNegInteger(party.capMinor, `party ${party.partyId}: capMinor`, 0);
    const capOverflowMinor = capMinor === null ? 0 : Math.max(0, afterDeductibleMinor - capMinor);
    // An at-fault third party is not covered by this insurer policy: its whole
    // apportioned loss is retained by that party regardless of cap/deductible.
    const insuredCovered = party.insuredCovered ?? true;
    const autoInsurerMinor = insuredCovered ? afterDeductibleMinor - capOverflowMinor : 0;

    let manualInsurerMinor: number | null = null;
    if (party.manualInsurerMinor !== undefined) {
      manualInsurerMinor = nonNegInteger(party.manualInsurerMinor, `party ${party.partyId}: manualInsurerMinor`, NaN);
      if (manualInsurerMinor > apportionedMinor) {
        throw new Error(`party ${party.partyId}: manual insurer amount ${manualInsurerMinor} exceeds apportioned loss ${apportionedMinor}`);
      }
      if (capMinor !== null && manualInsurerMinor > capMinor) {
        throw new Error(`party ${party.partyId}: manual insurer amount ${manualInsurerMinor} exceeds responsibility cap ${capMinor}`);
      }
      if (!party.manualReason || !String(party.manualReason).trim()) {
        throw new Error(`party ${party.partyId}: manualReason is required when manualInsurerMinor is set`);
      }
    }
    const insurerBorneMinor = manualInsurerMinor ?? autoInsurerMinor;
    const manualDeltaMinor = manualInsurerMinor === null ? 0 : manualInsurerMinor - autoInsurerMinor;
    const retainedMinor = apportionedMinor - insurerBorneMinor;

    // Step 5: already-paid amounts are offset against the freshly trialed
    // insurer share. Overpayment is surfaced as a recoverable amount, never
    // converted into a negative payable or spread to other parties.
    const priorPaidMinor = nonNegInteger(party.priorPaidMinor, `party ${party.partyId}: priorPaidMinor`, 0);
    const netPayableMinor = insurerBorneMinor - priorPaidMinor;
    const additionalPayableMinor = Math.max(0, netPayableMinor);
    const overpaidMinor = Math.max(0, -netPayableMinor);

    insurerTotal += insurerBorneMinor;
    retainedTotal += retainedMinor;
    priorPaidTotal += priorPaidMinor;
    additionalPayableTotal += additionalPayableMinor;
    overpaidTotal += overpaidMinor;

    return {
      partyId: party.partyId,
      role: party.role,
      insuredCovered,
      share: party.share,
      shareScaled: Number(scaled[index]),
      floorMinor,
      residualUnits: residualReceived,
      apportionedMinor,
      deductibleMinor,
      deductibleAppliedMinor,
      deductibleUnabsorbedMinor,
      afterDeductibleMinor,
      capMinor,
      capOverflowMinor,
      autoInsurerMinor,
      manualInsurerMinor,
      manualDeltaMinor,
      manualReason: party.manualReason,
      insurerBorneMinor,
      retainedMinor,
      priorPaidMinor,
      additionalPayableMinor,
      overpaidMinor,
    };
  });

  const shareBasisResidualValue = SHARE_SCALE - Number(scaledTotal);
  const conservation = buildConservation({
    grossMinor,
    parties,
    insurerTotal,
    retainedTotal,
    priorPaidTotal,
    additionalPayableTotal,
    overpaidTotal,
    residualUnits,
    shareBasisResidual: shareBasisResidualValue,
  });

  return {
    currency: input.currency,
    reason: input.reason ?? 'INITIAL_TRIAL',
    grossLossMinor: grossMinor,
    parties,
    totals: {
      insurerBorneMinor: insurerTotal,
      retainedMinor: retainedTotal,
      priorPaidMinor: priorPaidTotal,
      additionalPayableMinor: additionalPayableTotal,
      overpaidMinor: overpaidTotal,
    },
    changes: [],
    conservation,
  };
}

function buildConservation(args: {
  grossMinor: number;
  parties: AdjustmentPartyLine[];
  insurerTotal: number;
  retainedTotal: number;
  priorPaidTotal: number;
  additionalPayableTotal: number;
  overpaidTotal: number;
  residualUnits: number;
  shareBasisResidual: number;
}): AdjustmentConservation {
  const checks: Array<{ label: string; ok: boolean }> = [];
  const apportionedTotal = args.parties.reduce((sum, p) => sum + p.apportionedMinor, 0);
  checks.push({ label: `apportioned ${apportionedTotal} = gross loss ${args.grossMinor}`, ok: apportionedTotal === args.grossMinor });
  for (const p of args.parties) {
    checks.push({
      label: `party ${p.partyId}: insurer ${p.insurerBorneMinor} + retained ${p.retainedMinor} = apportioned ${p.apportionedMinor}`,
      ok: p.insurerBorneMinor + p.retainedMinor === p.apportionedMinor,
    });
    checks.push({ label: `party ${p.partyId}: no negative amount`, ok: p.insurerBorneMinor >= 0 && p.retainedMinor >= 0 && p.additionalPayableMinor >= 0 && p.overpaidMinor >= 0 });
    if (p.capMinor !== null) checks.push({ label: `party ${p.partyId}: insurer ${p.insurerBorneMinor} <= cap ${p.capMinor}`, ok: p.insurerBorneMinor <= p.capMinor });
    checks.push({ label: `party ${p.partyId}: payable ${p.additionalPayableMinor} - overpaid ${p.overpaidMinor} = insurer ${p.insurerBorneMinor} - paid ${p.priorPaidMinor}`, ok: p.additionalPayableMinor - p.overpaidMinor === p.insurerBorneMinor - p.priorPaidMinor });
  }
  checks.push({ label: `insurer ${args.insurerTotal} + retained ${args.retainedTotal} = gross ${args.grossMinor}`, ok: args.insurerTotal + args.retainedTotal === args.grossMinor });
  checks.push({
    label: `net payable ${args.additionalPayableTotal - args.overpaidTotal} = insurer total ${args.insurerTotal} - already paid ${args.priorPaidTotal}`,
    ok: args.additionalPayableTotal - args.overpaidTotal === args.insurerTotal - args.priorPaidTotal,
  });
  const balanced = checks.every((c) => c.ok);
  if (!balanced) {
    const failed = checks.filter((c) => !c.ok).map((c) => c.label);
    throw new Error(`adjustment conservation check failed: ${failed.join('; ')}`);
  }
  return {
    grossLossMinor: args.grossMinor,
    apportionedTotalMinor: apportionedTotal,
    insurerBorneTotalMinor: args.insurerTotal,
    retainedTotalMinor: args.retainedTotal,
    priorPaidTotalMinor: args.priorPaidTotal,
    additionalPayableTotalMinor: args.additionalPayableTotal,
    overpaidTotalMinor: args.overpaidTotal,
    liabilityResidualMinor: args.residualUnits,
    shareBasisResidual: args.shareBasisResidual,
    identities: checks.map((c) => c.label),
    balanced: true,
  };
}

/**
 * Explain every difference between two retained trial versions. Nothing is
 * discarded: the previous version stays stored verbatim, and each material
 * change (including rounding residual reassignment and carried-over payments)
 * gets an explicit, attributable source.
 */
export function diffAdjustments(previous: AdjustmentResult, next: AdjustmentResult): AdjustmentChange[] {
  const changes: AdjustmentChange[] = [];
  if (previous.grossLossMinor !== next.grossLossMinor) {
    changes.push({ code: 'TOTAL_LOSS_CHANGED', detail: 'gross loss changed between trials', fromMinor: previous.grossLossMinor, toMinor: next.grossLossMinor });
  }
  const prevById = new Map(previous.parties.map((p) => [p.partyId, p]));
  const nextById = new Map(next.parties.map((p) => [p.partyId, p]));
  for (const party of next.parties) {
    const before = prevById.get(party.partyId);
    if (!before) {
      changes.push({ code: 'PARTY_ADDED', partyId: party.partyId, detail: `party added with apportioned ${party.apportionedMinor}`, toMinor: party.apportionedMinor });
      continue;
    }
    if (party.share !== before.share) {
      changes.push({ code: 'LIABILITY_SHARE_CHANGED', partyId: party.partyId, detail: `share ${before.share} -> ${party.share}`, fromMinor: before.apportionedMinor, toMinor: party.apportionedMinor });
    }
    if (party.deductibleMinor !== before.deductibleMinor) {
      changes.push({ code: 'DEDUCTIBLE_CHANGED', partyId: party.partyId, detail: `deductible ${before.deductibleMinor} -> ${party.deductibleMinor}`, fromMinor: before.deductibleMinor, toMinor: party.deductibleMinor });
    }
    if (party.capMinor !== before.capMinor) {
      changes.push({ code: 'CAP_CHANGED', partyId: party.partyId, detail: `cap ${String(before.capMinor)} -> ${String(party.capMinor)}` });
    }
    if ((party.manualInsurerMinor ?? null) !== (before.manualInsurerMinor ?? null) || party.manualDeltaMinor !== before.manualDeltaMinor) {
      changes.push({
        code: 'MANUAL_OVERRIDE_CHANGED',
        partyId: party.partyId,
        detail: party.manualInsurerMinor === null ? 'manual override released' : `manual insurer amount ${party.manualInsurerMinor} (auto ${party.autoInsurerMinor}, delta ${party.manualDeltaMinor})`,
        fromMinor: before.insurerBorneMinor,
        toMinor: party.insurerBorneMinor,
      });
    }
    if (party.residualUnits !== before.residualUnits) {
      changes.push({ code: 'ROUNDING_RESIDUAL_REASSIGNED', partyId: party.partyId, detail: `largest-remainder units ${before.residualUnits} -> ${party.residualUnits}`, fromMinor: before.residualUnits, toMinor: party.residualUnits });
    }
    if (party.priorPaidMinor !== (before.priorPaidMinor ?? 0)) {
      changes.push({ code: 'PRIOR_PAYMENT_OFFSET', partyId: party.partyId, detail: `already paid carried at ${party.priorPaidMinor}`, fromMinor: before.priorPaidMinor ?? 0, toMinor: party.priorPaidMinor });
    }
    if (party.insurerBorneMinor !== before.insurerBorneMinor && !changes.some((c) => c.partyId === party.partyId && (c.code === 'LIABILITY_SHARE_CHANGED' || c.code === 'MANUAL_OVERRIDE_CHANGED' || c.code === 'DEDUCTIBLE_CHANGED' || c.code === 'CAP_CHANGED'))) {
      changes.push({ code: 'INSURER_AMOUNT_CHANGED', partyId: party.partyId, detail: `insurer-borne ${before.insurerBorneMinor} -> ${party.insurerBorneMinor}`, fromMinor: before.insurerBorneMinor, toMinor: party.insurerBorneMinor });
    }
  }
  for (const party of previous.parties) {
    if (!nextById.has(party.partyId)) changes.push({ code: 'PARTY_REMOVED', partyId: party.partyId, detail: `party removed, previously apportioned ${party.apportionedMinor}`, fromMinor: party.apportionedMinor });
  }
  if (previous.totals.insurerBorneMinor !== next.totals.insurerBorneMinor) {
    changes.push({ code: 'INSURER_TOTAL_CHANGED', detail: `insurer-borne total ${previous.totals.insurerBorneMinor} -> ${next.totals.insurerBorneMinor}`, fromMinor: previous.totals.insurerBorneMinor, toMinor: next.totals.insurerBorneMinor });
  }
  if (previous.totals.additionalPayableMinor !== next.totals.additionalPayableMinor || previous.totals.overpaidMinor !== next.totals.overpaidMinor) {
    changes.push({ code: 'PAYABLE_TOTAL_CHANGED', detail: `payable ${previous.totals.additionalPayableMinor} -> ${next.totals.additionalPayableMinor}, overpaid ${previous.totals.overpaidMinor} -> ${next.totals.overpaidMinor}` });
  }
  if (changes.length === 0) changes.push({ code: 'NO_SUBSTANTIVE_CHANGE', detail: 're-trial produced an identical allocation' });
  return changes;
}

/**
 * Build the default responsible-party inputs from a claim loss estimate and its
 * policy snapshot. The policy deductible/limit is attached to the insured side
 * (first structured party, or the `self` party when only a share is given).
 */
export function defaultPartyInputs(loss: LossEstimate, policy: PolicyVersion | undefined, priorPaidById?: Map<string, number>): AdjustmentPartyInput[] {
  const withPrior = (party: AdjustmentPartyInput): AdjustmentPartyInput => ({
    ...party,
    priorPaidMinor: priorPaidById?.get(party.partyId) ?? 0,
  });
  const structured: LiabilityParty[] | undefined = loss.liabilityParties;
  if (structured && structured.length) {
    const insuredIndex = structured.findIndex((p) => p.role === 'insured');
    return structured.map((party, index) => {
      const isInsured = index === (insuredIndex === -1 ? 0 : insuredIndex);
      return withPrior({
        partyId: party.partyId,
        share: party.share,
        role: party.role ?? (isInsured ? 'insured' : 'third_party'),
        insuredCovered: party.insuredCovered ?? isInsured,
        deductibleMinor: party.deductibleMinor ?? (isInsured ? policy?.deductibleMinor ?? 0 : 0),
        capMinor: party.capMinor ?? (isInsured ? policy?.limitMinor ?? 0 : undefined),
      });
    });
  }
  const ownShare = loss.liabilityShare ?? 1;
  const parties: AdjustmentPartyInput[] = [withPrior({
    partyId: 'self',
    role: 'insured',
    insuredCovered: true,
    share: ownShare,
    deductibleMinor: policy?.deductibleMinor ?? 0,
    capMinor: policy?.limitMinor ?? 0,
  })];
  if (ownShare < 1) parties.push(withPrior({ partyId: 'counterparty', role: 'third_party', insuredCovered: false, share: Math.round((1 - ownShare) * 1e9) / 1e9 }));
  return parties;
}
