export type ClaimStatus =
  | 'reported'
  | 'investigating'
  | 'awaiting_documents'
  | 'ready_for_adjustment'
  | 'partially_paid'
  | 'settled'
  | 'reopened'
  | 'rejected';

export type ClaimEventType =
  | 'claim.reported'
  | 'policy.snapshot.created'
  | 'evidence.added'
  | 'evidence.reviewed'
  | 'survey.assigned'
  | 'survey.completed'
  | 'documents.requested'
  | 'documents.received'
  | 'risk.assessed'
  | 'adjustment.trialed'
  | 'adjustment.approved'
  | 'payment.authorized'
  | 'payment.settled'
  | 'payment.reversed'
  | 'claim.reopened'
  | 'claim.rejected';

export interface Participant { kind: 'person' | 'vehicle' | 'device' | 'repair_shop' | 'account'; id: string; role?: string; }
export interface MonetaryAmount { currency: string; minor: number; }
export interface LossEstimate { currency: string; gross: number; deductible?: number; liabilityShare?: number; cap?: number; liabilityParties?: LiabilityParty[]; }

/**
 * Responsible party for a (multi-vehicle / multi-subject) loss.
 * `share` is a fraction of the gross loss; all parties' shares must sum to 1.
 */
export interface LiabilityParty { partyId: string; share: number; role?: string; insuredCovered?: boolean; deductibleMinor?: number; capMinor?: number; }

export interface AdjustmentPartyInput {
  partyId: string;
  share: number;
  role?: string;
  deductibleMinor?: number;
  capMinor?: number;
  /**
   * Whether *this* insurer's policy covers this party's share. The insured side
   * is covered; an at-fault third party is not — its share is retained by that
   * party and must never inflate the insurer-borne (payable) total.
   * Defaults to true for explicit party inputs.
   */
  insuredCovered?: boolean;
  /** Set to clamp this party's insurer-borne amount to a human-adjusted value. */
  manualInsurerMinor?: number;
  /** Mandatory audit explanation whenever manualInsurerMinor is provided. */
  manualReason?: string;
  /** Already posted settlement for this party, carried into the net payable calc. */
  priorPaidMinor?: number;
}

export interface AdjustmentTrialInput {
  currency: string;
  grossLossMinor: number;
  parties: AdjustmentPartyInput[];
  reason?: string;
}

export interface AdjustmentTrialInput {
  currency: string;
  grossLossMinor: number;
  parties: AdjustmentPartyInput[];
  reason?: string;
}

export interface AdjustmentPartyLine extends Omit<AdjustmentPartyInput, 'capMinor' | 'manualInsurerMinor' | 'priorPaidMinor'> {
  insuredCovered: boolean;
  role?: string;
  shareScaled: number;
  floorMinor: number;
  residualUnits: number;
  apportionedMinor: number;
  deductibleMinor: number;
  priorPaidMinor: number;
  deductibleAppliedMinor: number;
  deductibleUnabsorbedMinor: number;
  afterDeductibleMinor: number;
  capMinor: number | null;
  capOverflowMinor: number;
  autoInsurerMinor: number;
  manualInsurerMinor: number | null;
  manualDeltaMinor: number;
  insurerBorneMinor: number;
  retainedMinor: number;
  additionalPayableMinor: number;
  overpaidMinor: number;
}

export interface AdjustmentTotals {
  insurerBorneMinor: number;
  retainedMinor: number;
  priorPaidMinor: number;
  additionalPayableMinor: number;
  overpaidMinor: number;
}

export interface AdjustmentConservation {
  grossLossMinor: number;
  apportionedTotalMinor: number;
  insurerBorneTotalMinor: number;
  retainedTotalMinor: number;
  priorPaidTotalMinor: number;
  additionalPayableTotalMinor: number;
  overpaidTotalMinor: number;
  liabilityResidualMinor: number;
  shareBasisResidual: number;
  identities: string[];
  balanced: boolean;
}

export interface AdjustmentChange {
  code:
    | 'TOTAL_LOSS_CHANGED'
    | 'PARTY_ADDED'
    | 'PARTY_REMOVED'
    | 'LIABILITY_SHARE_CHANGED'
    | 'DEDUCTIBLE_CHANGED'
    | 'CAP_CHANGED'
    | 'MANUAL_OVERRIDE_CHANGED'
    | 'ROUNDING_RESIDUAL_REASSIGNED'
    | 'PRIOR_PAYMENT_OFFSET'
    | 'INSURER_AMOUNT_CHANGED'
    | 'INSURER_TOTAL_CHANGED'
    | 'PAYABLE_TOTAL_CHANGED'
    | 'NO_SUBSTANTIVE_CHANGE';
  partyId?: string;
  detail: string;
  fromMinor?: number;
  toMinor?: number;
}

export interface AdjustmentResult {
  currency: string;
  reason: string;
  grossLossMinor: number;
  parties: AdjustmentPartyLine[];
  totals: AdjustmentTotals;
  changes: AdjustmentChange[];
  conservation: AdjustmentConservation;
}

/** Immutable historical record of one payout trial. */
export interface AdjustmentTrial {
  version: number;
  occurredAt: string;
  actor: string;
  trigger: 'initial' | 'liability_change' | 'manual_readjustment' | 'recompute';
  source: 'liability' | 'manual' | 'recompute' | 'initial';
  basedOnVersion?: number;
  result: AdjustmentResult;
}
export interface PolicyVersion { policyId: string; version: number; effectiveFrom: string; effectiveTo?: string; coverages: string[]; deductibleMinor: number; limitMinor: number; }
export interface EvidenceRecord { id: string; kind: string; hash: string; version: number; receivedAt: string; reviewed: boolean; accepted?: boolean; source: string; supersedes?: string; }
export interface PaymentEntry { id: string; kind: 'authorization' | 'settlement' | 'reversal' | 'recovery'; amount: MonetaryAmount; sourceId: string; status: 'pending' | 'posted' | 'voided'; partyId?: string; createdAt: string; }
export interface RuleSnapshot { version: string; frozenAt: string; ruleIds: string[]; }
export interface RiskSignal { code: string; score: number; explanation: string; participants: string[]; }
export interface AuditEntry { sequence: number; eventId: string; type: ClaimEventType; occurredAt: string; actor: string; summary: string; }

export interface ClaimState {
  id: string;
  policyId: string;
  status: ClaimStatus;
  lossAt: string;
  reportedAt: string;
  channel: string;
  participants: Participant[];
  loss: LossEstimate;
  policy?: PolicyVersion;
  ruleSnapshot?: RuleSnapshot;
  evidence: EvidenceRecord[];
  requiredEvidence: Set<string>;
  completedSurveys: string[];
  pendingDocuments: string[];
  riskSignals: RiskSignal[];
  riskScore: number;
  payments: PaymentEntry[];
  /** Immutable history of every payout trial; the latest entry is authoritative. */
  adjustments: AdjustmentTrial[];
  approvedMinor: number;
  audit: AuditEntry[];
  processedEventIds: Set<string>;
  version: number;
}

export interface DomainEvent<T = unknown> {
  id: string;
  aggregateId: string;
  type: ClaimEventType;
  occurredAt: string;
  sequence: number;
  actor: string;
  idempotencyKey?: string;
  payload: T;
}

export interface ClaimReportedPayload {
  policyId: string; lossAt: string; reportedAt: string; channel: string;
  participants: Participant[]; loss: LossEstimate;
}
