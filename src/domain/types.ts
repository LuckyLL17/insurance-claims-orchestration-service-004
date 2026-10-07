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
  | 'adjustment.approved'
  | 'payment.authorized'
  | 'payment.settled'
  | 'payment.reversed'
  | 'claim.reopened'
  | 'claim.rejected';

export interface Participant { kind: 'person' | 'vehicle' | 'device' | 'repair_shop' | 'account'; id: string; role?: string; }
export interface MonetaryAmount { currency: string; minor: number; }
export interface LossCoverageTerms { deductible?: number; deductibleMinor?: number; cap?: number; capMinor?: number; }
export interface LossParty {
  id: string;
  liabilityShare?: number;
  deductible?: number;
  deductibleMinor?: number;
  cap?: number;
  capMinor?: number;
  coverages?: Record<string, LossCoverageTerms>;
}
export interface LossItem { id?: string; gross: number; cap?: number; capMinor?: number; }
export interface LossEstimate {
  currency: string;
  gross: number;
  deductible?: number;
  deductibleMinor?: number;
  liabilityShare?: number;
  cap?: number;
  capMinor?: number;
  parties?: LossParty[];
  items?: LossItem[];
}
export interface PolicyVersion { policyId: string; version: number; effectiveFrom: string; effectiveTo?: string; coverages: string[]; deductibleMinor: number; limitMinor: number; }
export interface EvidenceRecord { id: string; kind: string; hash: string; version: number; receivedAt: string; reviewed: boolean; accepted?: boolean; source: string; supersedes?: string; }
export interface PaymentEntry { id: string; kind: 'authorization' | 'settlement' | 'reversal' | 'recovery'; amount: MonetaryAmount; sourceId: string; status: 'pending' | 'posted' | 'voided'; createdAt: string; allocations?: PaymentAllocation[]; }
export interface PaymentAllocation { partyId: string; minor: number; }

export type AdjustmentBasis = 'calculated' | 'manual';
export type AdjustmentDifferenceCode =
  | 'liability-share-changed'
  | 'manual-adjustment'
  | 'loss-changed'
  | 'deductible-changed'
  | 'cap-changed'
  | 'manual-adjustment'
  | 'rounding-residual'
  | 'payment-overpaid'
  | 'party-added'
  | 'party-removed';
export type CapStage = 'item-cap' | 'party-cap' | 'coverage-cap';
export interface AdjustmentCell {
  partyId: string;
  itemId: string;
  liabilityShareMinor: number;
  grossMinor: number;
  deductibleAppliedMinor: number;
  afterDeductibleMinor: number;
  itemCapExcessMinor: number;
  partyCapExcessMinor: number;
  coverageCapExcessMinor: number;
  globalCapExcessMinor: number;
  manualAdjustmentMinor: number;
  manualExcessMinor: number;
  insurerMinor: number;
  insuredMinor: number;
}
export interface AdjustmentPartyResult {
  partyId: string;
  liabilityShare: number;
  grossMinor: number;
  deductibleNominalMinor: number;
  deductibleSource: 'global' | 'party' | 'coverage';
  capMinor?: number;
  deductibleAppliedMinor: number;
  deductibleUnusedMinor: number;
  afterDeductibleMinor: number;
  itemCapExcessMinor: number;
  partyCapExcessMinor: number;
  coverageCapExcessMinor: number;
  globalCapExcessMinor: number;
  manualAdjustmentMinor: number;
  manualExcessMinor: number;
  insurerMinor: number;
  insuredMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  overpaidMinor: number;
}
export interface AdjustmentItemResult {
  itemId: string;
  grossMinor: number;
  capMinor?: number;
  deductibleAppliedMinor: number;
  insurerMinor: number;
  insuredMinor: number;
  itemCapExcessMinor: number;
  partyCapExcessMinor: number;
  coverageCapExcessMinor: number;
  globalCapExcessMinor: number;
  manualAdjustmentMinor: number;
  manualExcessMinor: number;
}
export interface AdjustmentDifference {
  code: AdjustmentDifferenceCode;
  partyId?: string;
  itemId?: string;
  field?: string;
  before?: number | string;
  after?: number | string;
  deltaMinor?: number;
  source: string;
}
export interface AdjustmentReconciliation {
  grossMinor: number;
  insurerMinor: number;
  insuredMinor: number;
  deductibleAppliedMinor: number;
  itemCapExcessMinor: number;
  partyCapExcessMinor: number;
  coverageCapExcessMinor: number;
  globalCapExcessMinor: number;
  manualAdjustmentMinor: number;
  manualExcessMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  overpaidMinor: number;
  roundingResidualMinor: number;
  unallocatedPaidMinor: number;
}
export interface AdjustmentResult {
  basis: AdjustmentBasis;
  currency: string;
  grossMinor: number;
  globalDeductibleNominalMinor: number;
  globalCapMinor?: number;
  liabilityShares: Record<string, number>;
  cells: AdjustmentCell[];
  parties: AdjustmentPartyResult[];
  items: AdjustmentItemResult[];
  approvedMinor: number;
  insuredResponsibilityMinor: number;
  deductibleAppliedMinor: number;
  itemCapExcessMinor: number;
  partyCapExcessMinor: number;
  coverageCapExcessMinor: number;
  globalCapExcessMinor: number;
  manualAdjustmentMinor: number;
  manualExcessMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  overpaidMinor: number;
  unallocatedPaidMinor: number;
  roundingResidualMinor: number;
  differences: AdjustmentDifference[];
  differenceSources: string[];
  reconciliation: AdjustmentReconciliation;
}
export interface AdjustmentRecord extends AdjustmentResult {
  id: string;
  revision: number;
  createdAt: string;
  actor: string;
  reason?: string;
  previousAdjustmentId?: string;
  request: Record<string, unknown>;
}
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
  approvedMinor: number;
  adjustments: AdjustmentRecord[];
  currentAdjustmentId?: string;
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
