import { EventStore } from './event-store';
import { EvidenceLedger } from '../domain/evidence';
import { PolicyCatalog } from '../domain/policy';
import { RuleEngine } from '../domain/rules';
import { ClaimReportedPayload, ClaimState, DomainEvent, AdjustmentRecord, AdjustmentResult } from '../domain/types';
import { newId, iso } from '../domain/ids';
import { calculateAdjustment, claimToAdjustmentInput, CalculateAdjustmentInput } from '../domain/adjustment';

export class ClaimService {
  constructor(private readonly events: EventStore, private readonly policies: PolicyCatalog, private readonly rules: RuleEngine, private readonly evidence: EvidenceLedger) {}

  create(input: ClaimReportedPayload, actor: string, key?: string): ClaimState {
    const id = newId('claim');
    this.events.append(id, 'claim.reported', { ...input, lossAt: iso(input.lossAt), reportedAt: iso(input.reportedAt) }, actor, key);
    this.events.append(id, 'policy.snapshot.created', { policy: this.policies.snapshot(input.policyId, input.lossAt), ruleSnapshot: this.rules.freeze() }, 'system', `policy:${id}`);
    return this.get(id);
  }

  addEvent(id: string, type: DomainEvent['type'], payload: unknown, actor: string, key?: string, occurredAt?: string): ClaimState { this.assertExists(id); this.events.append(id, type, payload, actor, key, occurredAt); return this.get(id); }

  addEvidence(id: string, input: { kind: string; source: string; content: unknown; receivedAt?: string; supersedes?: string }, actor: string, key?: string): ClaimState {
    const claim = this.get(id); const record = this.evidence.add(input, claim.evidence); return this.addEvent(id, 'evidence.added', { evidence: record }, actor, key, input.receivedAt);
  }

  reviewEvidence(id: string, evidenceId: string, accepted: boolean, actor: string, key?: string): ClaimState {
    const claim = this.get(id); const record = this.evidence.review(evidenceId, accepted, claim.evidence); return this.addEvent(id, 'evidence.reviewed', { evidence: record }, actor, key);
  }

  calculateAdjustment(id: string, input: CalculateAdjustmentInput = {}): AdjustmentResult {
    const claim = this.get(id);
    return calculateAdjustment(claimToAdjustmentInput(claim, { ...input, request: { ...(input.request ?? {}) } }));
  }

  approveAdjustment(id: string, input: CalculateAdjustmentInput = {}, actor: string, key?: string, reason?: string): ClaimState {
    const claim = this.get(id);
    const previous = claim.adjustments.find((record) => record.id === claim.currentAdjustmentId);
    const adjustment = calculateAdjustment(claimToAdjustmentInput(claim, {
      ...input,
      basis: input.basis ?? (input.manual || input.parties?.some((party) => party.insurerOverride !== undefined || party.insurerOverrideMinor !== undefined) ? 'manual' : 'calculated'),
      differenceSource: input.differenceSource ?? actor,
      request: { ...input } as Record<string, unknown>,
    }));
    const revision = (previous?.revision ?? 0) + 1;
    const record: AdjustmentRecord = {
      ...adjustment,
      id: newId('adjustment'),
      revision,
      createdAt: iso(),
      actor,
      reason,
      previousAdjustmentId: previous?.id,
      request: { ...input } as Record<string, unknown>,
    };
    const requiredEvidence = claim.loss.gross >= 100000 ? ['loss-photo', 'repair-estimate', 'police-report'] : ['loss-photo', 'repair-estimate'];
    this.events.append(id, 'adjustment.approved', { approvedMinor: adjustment.approvedMinor, adjustment: record, requiredEvidence }, actor, key ?? `adjustment:${id}:${revision}`);
    return this.get(id);
  }

  get(id: string): ClaimState { return this.replay(id, this.events.list(id)); }
  replay(id: string, events: DomainEvent[]): ClaimState {
    const state = this.empty(id);
    for (const event of events.sort((a, b) => a.sequence - b.sequence)) this.apply(state, event);
    if (!state.policy) throw new Error(`claim ${id} has no policy snapshot`);
    return state;
  }

  private empty(id: string): ClaimState { return { id, policyId: '', status: 'reported', lossAt: '', reportedAt: '', channel: '', participants: [], loss: { currency: 'CNY', gross: 0 }, evidence: [], requiredEvidence: new Set(), completedSurveys: [], pendingDocuments: [], riskSignals: [], riskScore: 0, payments: [], approvedMinor: 0, adjustments: [], audit: [], processedEventIds: new Set(), version: 0 }; }
  private assertExists(id: string): void { if (this.events.list(id).length === 0) throw new Error(`unknown claim ${id}`); }

  private apply(state: ClaimState, event: DomainEvent): void {
    if (state.processedEventIds.has(event.id)) return; state.processedEventIds.add(event.id); state.version = event.sequence;
    const payload = event.payload as any;
    if (event.type === 'claim.reported') { state.policyId = payload.policyId; state.lossAt = payload.lossAt; state.reportedAt = payload.reportedAt; state.channel = payload.channel; state.participants = payload.participants; state.loss = payload.loss; state.status = 'reported'; }
    if (event.type === 'policy.snapshot.created') { state.policy = payload.policy; state.ruleSnapshot = payload.ruleSnapshot; }
    if (event.type === 'evidence.added') { state.evidence = [...state.evidence.filter((e) => e.id !== payload.evidence.id), payload.evidence]; state.status = state.status === 'reported' ? 'investigating' : state.status; }
    if (event.type === 'evidence.reviewed') { state.evidence = state.evidence.map((e) => e.id === payload.evidence.id ? payload.evidence : e); }
    if (event.type === 'documents.requested') { state.pendingDocuments = [...new Set([...(state.pendingDocuments), ...(payload.kinds ?? [])])]; state.status = 'awaiting_documents'; }
    if (event.type === 'documents.received') { state.pendingDocuments = state.pendingDocuments.filter((kind) => !(payload.kinds ?? []).includes(kind)); if (!state.pendingDocuments.length) state.status = 'ready_for_adjustment'; }
    if (event.type === 'survey.completed') { state.completedSurveys = [...new Set([...state.completedSurveys, payload.taskId])]; }
    if (event.type === 'risk.assessed') { state.riskSignals = payload.signals; state.riskScore = payload.score; }
    if (event.type === 'adjustment.approved') {
      const record: AdjustmentRecord = payload.adjustment ?? {
        id: newId('legacy-adjustment'),
        revision: state.adjustments.length + 1,
        createdAt: event.occurredAt,
        actor: event.actor,
        request: {},
        basis: 'calculated',
        currency: state.loss.currency,
        grossMinor: Math.round(state.loss.gross * 100),
        globalDeductibleNominalMinor: state.policy?.deductibleMinor ?? 0,
        globalCapMinor: state.policy?.limitMinor,
        liabilityShares: { 'party-1': 1 },
        cells: [],
        parties: [],
        items: [],
        approvedMinor: payload.approvedMinor,
        insuredResponsibilityMinor: Math.round(state.loss.gross * 100) - payload.approvedMinor,
        deductibleAppliedMinor: state.policy?.deductibleMinor ?? 0,
        itemCapExcessMinor: 0,
        partyCapExcessMinor: 0,
        coverageCapExcessMinor: 0,
        globalCapExcessMinor: 0,
        manualAdjustmentMinor: 0,
        manualExcessMinor: 0,
        paidMinor: 0,
        outstandingMinor: payload.approvedMinor,
        overpaidMinor: 0,
        unallocatedPaidMinor: 0,
        roundingResidualMinor: 0,
        differences: [],
        differenceSources: [],
        reconciliation: {
          grossMinor: Math.round(state.loss.gross * 100),
          insurerMinor: payload.approvedMinor,
          insuredMinor: Math.round(state.loss.gross * 100) - payload.approvedMinor,
          deductibleAppliedMinor: state.policy?.deductibleMinor ?? 0,
          itemCapExcessMinor: 0,
          partyCapExcessMinor: 0,
          coverageCapExcessMinor: 0,
          globalCapExcessMinor: 0,
          manualAdjustmentMinor: 0,
          manualExcessMinor: 0,
          paidMinor: 0,
          outstandingMinor: payload.approvedMinor,
          overpaidMinor: 0,
          roundingResidualMinor: 0,
          unallocatedPaidMinor: 0,
        },
      };
      state.adjustments = [...state.adjustments, record];
      state.currentAdjustmentId = record.id;
      state.approvedMinor = payload.approvedMinor;
      state.requiredEvidence = new Set(payload.requiredEvidence);
      state.status = record.overpaidMinor > 0 ? 'reopened' : record.paidMinor >= record.approvedMinor && record.approvedMinor > 0 ? 'settled' : record.paidMinor > 0 ? 'partially_paid' : 'ready_for_adjustment';
    }
    if (event.type === 'payment.settled' || event.type === 'payment.reversed') {
      state.payments = [...state.payments, payload.payment];
      const current = state.adjustments.find((record) => record.id === state.currentAdjustmentId);
      if (current) {
        const byParty = new Map(current.parties.map((party) => [party.partyId, 0]));
        let unallocated = 0;
        for (const payment of state.payments.filter((entry) => entry.status === 'posted')) {
          if (payment.allocations?.length) for (const allocation of payment.allocations) {
            if (byParty.has(allocation.partyId)) byParty.set(allocation.partyId, (byParty.get(allocation.partyId) ?? 0) + allocation.minor);
            else unallocated += allocation.minor;
          } else unallocated += payment.amount.minor;
        }
        const paidMinor = [...byParty.values()].reduce((sum, value) => sum + value, 0) + unallocated;
        const parties = current.parties.map((party) => {
          const partyPaid = (byParty.get(party.partyId) ?? 0) + (unallocated ? 0 : 0);
          return {
            ...party,
            paidMinor: partyPaid,
            outstandingMinor: Math.max(0, party.insurerMinor - partyPaid),
            overpaidMinor: Math.max(0, partyPaid - party.insurerMinor),
          };
        });
        const refreshed: AdjustmentRecord = {
          ...current,
          parties,
          paidMinor,
          unallocatedPaidMinor: unallocated,
          outstandingMinor: Math.max(0, current.approvedMinor - paidMinor),
          overpaidMinor: Math.max(0, paidMinor - current.approvedMinor),
          reconciliation: { ...current.reconciliation, paidMinor, unallocatedPaidMinor: unallocated, outstandingMinor: Math.max(0, current.approvedMinor - paidMinor), overpaidMinor: Math.max(0, paidMinor - current.approvedMinor) },
        };
        state.adjustments = state.adjustments.map((record) => record.id === refreshed.id ? refreshed : record);
      }
      const settled = state.payments.filter((entry) => entry.status === 'posted').reduce((sum, entry) => sum + entry.amount.minor, 0);
      state.status = payload.payment.kind === 'reversal' ? 'reopened' : settled >= state.approvedMinor ? 'settled' : 'partially_paid';
    }
    if (event.type === 'claim.reopened') state.status = 'reopened';
    if (event.type === 'claim.rejected') state.status = 'rejected';
    state.audit.push({ sequence: event.sequence, eventId: event.id, type: event.type, occurredAt: event.occurredAt, actor: event.actor, summary: `${event.type} accepted` });
  }
}
