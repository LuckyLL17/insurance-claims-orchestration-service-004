import {
  AdjustmentCell,
  AdjustmentDifference,
  AdjustmentDifferenceCode,
  AdjustmentPartyResult,
  AdjustmentResult,
  ClaimState,
  LossCoverageTerms,
  LossEstimate,
  LossItem,
  LossParty,
  PaymentAllocation,
  PaymentEntry,
} from './types';

export interface AdjustmentPartyInput {
  id: string;
  liabilityShare?: number;
  deductible?: number;
  deductibleMinor?: number;
  cap?: number;
  capMinor?: number;
  insurerOverride?: number;
  insurerOverrideMinor?: number;
  paid?: number;
  paidMinor?: number;
  coverages?: Record<string, { deductible?: number; deductibleMinor?: number; cap?: number; capMinor?: number }>;
}
export interface AdjustmentItemInput {
  id?: string;
  gross?: number;
  grossMinor?: number;
  cap?: number;
  capMinor?: number;
}
export interface CalculateAdjustmentInput {
  currency?: string;
  gross?: number;
  grossMinor?: number;
  deductible?: number;
  deductibleMinor?: number;
  cap?: number;
  capMinor?: number;
  liabilityShare?: number;
  parties?: AdjustmentPartyInput[];
  items?: AdjustmentItemInput[];
  paidByParty?: Record<string, number>;
  paidMinorByParty?: Record<string, number>;
  manual?: boolean;
  basis?: AdjustmentResult['basis'];
  differenceSource?: string;
  previous?: AdjustmentResult;
  request?: Record<string, unknown>;
}

interface NormalizedParty {
  id: string;
  shareWeight: number;
  deductibleMinor?: number;
  capMinor?: number;
  insurerOverrideMinor?: number;
  paidMinor?: number;
  coverages: Record<string, { deductibleMinor?: number; capMinor?: number }>;
}
interface NormalizedItem { id: string; grossMinor: number; capMinor?: number; }
interface WorkingCell extends AdjustmentCell {
  coverageId: string;
  index: number;
  afterItemCapMinor: number;
  afterPartyCapMinor: number;
  afterCoverageCapMinor: number;
}

const EPSILON = 1e-9;

function isNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer minor amount`);
}
function explicitMinor(value: number | undefined, minor: number | undefined, name: string): number | undefined {
  if (value !== undefined && minor !== undefined) throw new Error(`${name} cannot be provided in both major and minor units`);
  if (minor !== undefined) { assertNonNegativeInteger(minor, name); return minor; }
  if (value !== undefined) return toMinor(value, name);
  return undefined;
}
export function toMinor(value: number, name = 'amount'): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite amount`);
  const minor = value * 100;
  if (Math.abs(minor - Math.round(minor)) > EPSILON) throw new Error(`${name} cannot be split below the minimum currency unit`);
  return Math.round(minor);
}
function assertOptionalNonNegative(limit: number | undefined, name: string): void {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error(`${name} must be a non-negative integer`);
}
function coverageId(itemId: string): string { return itemId; }
function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }

/**
 * Distribute an integer total using largest remainders. Inputs are kept in
 * minor units, so every cent is assigned to a real bucket instead of being
 * truncated into a balancing loss.
 */
export function allocateLargestRemainder(total: number, weights: Array<number | undefined>, bucket = 'allocation'): number[] {
  assertNonNegativeInteger(total, bucket);
  if (!weights.length) throw new Error(`${bucket} requires at least one bucket`);
  const normalized = weights.map((weight, index) => {
    if (!isNumber(weight) || weight < 0) throw new Error(`${bucket}[${index}] weight must be a non-negative number`);
    return weight;
  });
  const weightTotal = normalized.reduce((totalWeight, weight) => totalWeight + weight, 0);
  if (weightTotal <= 0) return allocateLargestRemainder(total, normalized.map(() => 1), bucket);
  const exact = normalized.map((weight) => total * weight / weightTotal);
  const floor = exact.map((value) => Math.floor(value));
  let remainder = total - sum(floor);
  const order = exact
    .map((value, index) => ({ index, fractional: value - floor[index], weight: normalized[index] }))
    .sort((a, b) => b.fractional - a.fractional || b.weight - a.weight || a.index - b.index)
    .map(({ index }) => index);
  let cursor = 0;
  while (remainder > 0) {
    floor[order[cursor % order.length]] += 1;
    remainder -= 1;
    cursor += 1;
  }
  return floor;
}

export function allocatePayment(total: number, parties: Array<Pick<AdjustmentPartyResult, 'partyId'> & { insurerMinor: number }>, source = 'payment'): PaymentAllocation[] {
  const amount = allocateLargestRemainder(total, parties.map((party) => party.insurerMinor), source);
  return parties.map((party, index) => ({ partyId: party.partyId, minor: amount[index] })).filter((allocation) => allocation.minor !== 0);
}

/**
 * Build an integer party x loss-item matrix. Both each party's total liability
 * share and each item's total loss are fixed at the same time; odd cents move
 * between columns rather than being repeatedly assigned to the same party.
 */
export function allocateLiabilityMatrix(total: number, itemTotals: number[], weights: number[]): number[][] {
  if (sum(itemTotals) !== total) throw new Error('liability matrix item totals do not match gross loss');
  if (total === 0) return weights.map(() => itemTotals.map(() => 0));
  const rowCount = weights.length;
  const columnCount = itemTotals.length;
  const rowTotals = allocateLargestRemainder(total, weights, 'liability gross');
  const matrix = Array.from({ length: rowCount }, () => new Array<number>(columnCount).fill(0));
  const ideals = rowTotals.map((rowTotal) => itemTotals.map((columnTotal) => rowTotal * columnTotal / total));
  ideals.forEach((row, rowIndex) => row.forEach((ideal, columnIndex) => { matrix[rowIndex][columnIndex] = Math.floor(ideal); }));
  const rowResiduals = rowTotals.map((rowTotal, row) => rowTotal - sum(matrix[row]));
  const columnResiduals = itemTotals.map((columnTotal, column) => columnTotal - sum(matrix.map((row) => row[column])));
  const residualTotal = sum(rowResiduals);
  if (residualTotal !== sum(columnResiduals)) throw new Error('liability matrix residual totals do not match');

  const source = 0;
  const rowNode = (row: number) => row + 1;
  const columnNode = (column: number) => rowCount + column + 1;
  const sink = rowCount + columnCount + 1;
  interface MatrixFlowEdge { from: number; to: number; capacity: number; row?: number; column?: number; }
  const edges: MatrixFlowEdge[] = [];
  const adjacency = Array.from({ length: sink + 1 }, () => [] as number[]);
  const addEdge = (from: number, to: number, capacity: number, row?: number, column?: number) => {
    edges.push({ from, to, capacity, row, column });
    adjacency[from].push(edges.length - 1);
    edges.push({ from: to, to: from, capacity: 0, row, column });
    adjacency[to].push(edges.length - 1);
  };
  rowResiduals.forEach((capacity, row) => addEdge(source, rowNode(row), capacity));
  columnResiduals.forEach((capacity, column) => addEdge(columnNode(column), sink, capacity));
  const matrixEdgeIndices = new Map<string, number>();
  const addMatrixEdge = (row: number, column: number, capacity: number) => {
    const key = `${row}:${column}`;
    if (matrixEdgeIndices.has(key)) return;
    addEdge(rowNode(row), columnNode(column), capacity, row, column);
    matrixEdgeIndices.set(key, edges.length - 2);
  };
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      if (ideals[row][column] - matrix[row][column] > EPSILON) addMatrixEdge(row, column, 1);
    }
  }

  let flow = 0;
  while (flow < residualTotal) {
    const previousEdge = new Array<number>(sink + 1).fill(-1);
    const queue = [source];
    previousEdge[source] = -2;
    while (queue.length && previousEdge[sink] === -1) {
      const from = queue.shift() as number;
      for (const edgeIndex of adjacency[from]) {
        const edge = edges[edgeIndex];
        if (edge.capacity > 0 && previousEdge[edge.to] === -1) {
          previousEdge[edge.to] = edgeIndex;
          queue.push(edge.to);
        }
      }
    }
    if (previousEdge[sink] === -1) {
      const missing: Array<[number, number]> = [];
      for (let row = 0; row < rowCount; row += 1) {
        for (let column = 0; column < columnCount; column += 1) {
          const key = `${row}:${column}`;
          if (!matrixEdgeIndices.has(key)) missing.push([row, column]);
        }
      }
      if (!missing.length) throw new Error('liability matrix cannot satisfy party and item totals');
      const [fallbackRow, fallbackColumn] = missing[0];
      addMatrixEdge(fallbackRow, fallbackColumn, 1);
      continue;
    }
    let bottleneck = Number.MAX_SAFE_INTEGER;
    for (let node = sink; node !== source; node = edges[previousEdge[node]].from) bottleneck = Math.min(bottleneck, edges[previousEdge[node]].capacity);
    for (let node = sink; node !== source; node = edges[previousEdge[node]].from) {
      const edgeIndex = previousEdge[node];
      edges[edgeIndex].capacity -= bottleneck;
      edges[edgeIndex ^ 1].capacity += bottleneck;
    }
    flow += bottleneck;
  }

  for (const [key, edgeIndex] of matrixEdgeIndices) {
    const [row, column] = key.split(':').map(Number);
    matrix[row][column] += edges[edgeIndex ^ 1].capacity;
  }

  for (let row = 0; row < rowCount; row += 1) {
    if (sum(matrix[row]) !== rowTotals[row]) throw new Error('liability matrix row total was not conserved');
  }
  for (let column = 0; column < columnCount; column += 1) {
    if (sum(matrix.map((row) => row[column])) !== itemTotals[column]) throw new Error('liability matrix column total was not conserved');
  }
  return matrix;
}

function mapCoverageTerms(terms: LossCoverageTerms | undefined): { deductibleMinor?: number; capMinor?: number } {
  if (!terms) return {};
  const deductibleMinor = explicitMinor(terms.deductible, terms.deductibleMinor, 'coverage deductible');
  const capMinor = explicitMinor(terms.cap, terms.capMinor, 'coverage cap');
  return { deductibleMinor, capMinor };
}
function normalizeParty(party: AdjustmentPartyInput | LossParty, index: number): NormalizedParty {
  if (!party.id || typeof party.id !== 'string') throw new Error(`party[${index}].id is required`);
  const liabilityShare = party.liabilityShare ?? 1;
  if (!isNumber(liabilityShare) || liabilityShare < 0) throw new Error(`party ${party.id} liabilityShare must be non-negative`);
  const coveragesInput = 'coverages' in party && party.coverages ? party.coverages : {};
  const coverages = Object.fromEntries(Object.entries(coveragesInput).map(([id, terms]) => [id, mapCoverageTerms(terms)]));
  return {
    id: party.id,
    shareWeight: liabilityShare,
    deductibleMinor: explicitMinor(party.deductible, party.deductibleMinor, `party ${party.id} deductible`),
    capMinor: explicitMinor(party.cap, party.capMinor, `party ${party.id} cap`),
    insurerOverrideMinor: explicitMinor((party as AdjustmentPartyInput).insurerOverride, (party as AdjustmentPartyInput).insurerOverrideMinor, `party ${party.id} insurerOverride`),
    paidMinor: explicitMinor((party as AdjustmentPartyInput).paid, (party as AdjustmentPartyInput).paidMinor, `party ${party.id} paid`),
    coverages,
  };
}
function normalizeItem(item: AdjustmentItemInput | LossItem, index: number, fallbackId: string): NormalizedItem {
  const grossMinor = explicitMinor(item.gross, (item as AdjustmentItemInput).grossMinor, `item[${index}] gross`);
  if (grossMinor === undefined) throw new Error(`item[${index}] gross is required`);
  const capMinor = explicitMinor(item.cap, item.capMinor, `item[${index}] cap`);
  return { id: item.id ?? fallbackId, grossMinor, capMinor };
}
function uniqueIds(values: Array<{ id: string }>, name: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) throw new Error(`duplicate ${name} id: ${value.id}`);
    seen.add(value.id);
  }
}
function normalizePaid(input: CalculateAdjustmentInput, parties: NormalizedParty[]): Map<string, number> {
  const paid = new Map<string, number>();
  const major = input.paidByParty ?? {};
  const minor = input.paidMinorByParty ?? {};
  for (const party of parties) {
    if (major[party.id] !== undefined && minor[party.id] !== undefined) throw new Error(`party ${party.id} paid cannot use major and minor units together`);
    const value = major[party.id] !== undefined ? toMinor(major[party.id], `party ${party.id} paid`) : minor[party.id] ?? party.paidMinor ?? 0;
    assertNonNegativeInteger(value, `party ${party.id} paid`);
    paid.set(party.id, value);
  }
  for (const id of Object.keys(major)) if (!paid.has(id)) throw new Error(`paid amount references unknown party: ${id}`);
  for (const id of Object.keys(minor)) if (!paid.has(id)) throw new Error(`paid amount references unknown party: ${id}`);
  return paid;
}

function applyStage(cells: WorkingCell[], getBefore: (cell: WorkingCell) => number, setResult: (cell: WorkingCell, amount: number, excess: number) => void, groupKey: (cell: WorkingCell) => string | null, getLimit: (key: string) => number | undefined): void {
  const groups = new Map<string, WorkingCell[]>();
  for (const cell of cells) {
    const key = groupKey(cell);
    if (key === null) continue;
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  for (const [key, groupCells] of groups) {
    const limit = getLimit(key);
    if (limit === undefined) {
      for (const cell of groupCells) setResult(cell, getBefore(cell), 0);
      continue;
    }
    assertOptionalNonNegative(limit, `${groupKey.name} limit`);
    const beforeTotal = sum(groupCells.map(getBefore));
    const resultTotal = Math.min(beforeTotal, limit);
    const amounts = allocateLargestRemainder(resultTotal, groupCells.map(getBefore), `${key} capped allocation`);
    groupCells.forEach((cell, index) => setResult(cell, amounts[index], getBefore(cell) - amounts[index]));
  }
}

export function calculateAdjustment(input: CalculateAdjustmentInput = {}): AdjustmentResult {
  const grossMinor = explicitMinor(input.gross, input.grossMinor, 'gross loss')
    ?? (input.items?.length ? undefined : 0);
  const globalDeductibleNominalMinor = explicitMinor(input.deductible, input.deductibleMinor, 'deductible') ?? 0;
  const globalCapMinor = explicitMinor(input.cap, input.capMinor, 'global cap');
  const rawParties = input.parties?.length ? input.parties : [{ id: 'party-1', liabilityShare: input.liabilityShare ?? 1 }];
  const hasExplicitPartyDeductible = rawParties.some((party) => party.deductible !== undefined || party.deductibleMinor !== undefined);
  const hasExplicitCoverageDeductible = rawParties.some((party) => Object.values(party.coverages ?? {}).some((terms) => terms.deductible !== undefined || terms.deductibleMinor !== undefined));
  const parties = rawParties.map(normalizeParty);
  const globalExplicit = globalDeductibleNominalMinor > 0 && (hasExplicitPartyDeductible || hasExplicitCoverageDeductible);
  if (globalExplicit) throw new Error('global deductible cannot be combined with party or coverage deductibles');
  const useGlobalDeductible = globalDeductibleNominalMinor > 0 && !hasExplicitPartyDeductible && !hasExplicitCoverageDeductible;
  uniqueIds(parties, 'party');
  const shareTotal = sum(parties.map((party) => party.shareWeight));
  if (shareTotal <= 0) throw new Error('liability shares must have a positive total');
  const liabilityShares: Record<string, number> = {};
  for (const party of parties) liabilityShares[party.id] = party.shareWeight / shareTotal;

  const inputItems = input.items;
  const rawItems = inputItems && inputItems.length
    ? inputItems.map((item, index) => normalizeItem(item, index, inputItems.length === 1 ? 'loss' : `item-${index + 1}`))
    : [{ id: 'loss', grossMinor: grossMinor ?? 0 }];
  const items = rawItems;
  uniqueIds(items, 'item');
  const itemGrossTotal = sum(items.map((item) => item.grossMinor));
  if (grossMinor !== undefined && itemGrossTotal !== grossMinor) throw new Error('item gross amounts do not equal total gross loss');
  const totalGross = itemGrossTotal;

  const partyGross = allocateLargestRemainder(totalGross, parties.map((party) => party.shareWeight), 'liability gross');
  const shareMinor = allocateLargestRemainder(1_000_000, parties.map((party) => party.shareWeight), 'liability share');
  const liabilityShareMinorByParty = new Map(parties.map((party, partyIndex) => [party.id, shareMinor[partyIndex]]));
  const grossByParty = new Map(parties.map((party, index) => [party.id, partyGross[index]]));
  const paid = normalizePaid(input, parties);
  let index = 0;
  let cells: WorkingCell[] = [];
  const globalAllocations = new Map(parties.map((party) => [party.id, 0]));
  if (useGlobalDeductible) {
    const allocated = allocateLargestRemainder(Math.min(globalDeductibleNominalMinor, totalGross), parties.map((party) => grossByParty.get(party.id) ?? 0), 'global deductible');
    parties.forEach((party, partyIndex) => globalAllocations.set(party.id, allocated[partyIndex]));
  }

  const liabilityMatrix = allocateLiabilityMatrix(totalGross, items.map((item) => item.grossMinor), parties.map((party) => party.shareWeight));
  const globalDeductibleCellAllocations = new Map<string, number[]>();
  if (useGlobalDeductible) {
    parties.forEach((party, partyIndex) => {
      const rowGross = liabilityMatrix[partyIndex];
      globalDeductibleCellAllocations.set(party.id, allocateLargestRemainder(globalAllocations.get(party.id) ?? 0, rowGross, `global deductible for ${party.id}`));
    });
  }
  const partyDeductibleAllocations = new Map<string, number[]>();
  parties.forEach((party, partyIndex) => {
    const rowGross = liabilityMatrix[partyIndex];
    if (party.deductibleMinor === undefined) {
      partyDeductibleAllocations.set(party.id, globalDeductibleCellAllocations.get(party.id) ?? items.map(() => 0));
      return;
    }
    partyDeductibleAllocations.set(party.id, allocateLargestRemainder(Math.min(party.deductibleMinor, sum(rowGross)), rowGross, `party ${party.id} deductible`));
  });

  items.forEach((item, itemIndex) => {
    parties.forEach((party, partyIndex) => {
      const grossMinor = liabilityMatrix[partyIndex][itemIndex];
      const cell: WorkingCell = {
        partyId: party.id,
        itemId: item.id,
        coverageId: coverageId(item.id),
        index: index++,
        liabilityShareMinor: liabilityShareMinorByParty.get(party.id) ?? 0,
        grossMinor: grossMinor,
        deductibleAppliedMinor: 0,
        afterDeductibleMinor: grossMinor,
        itemCapExcessMinor: 0,
        partyCapExcessMinor: 0,
        coverageCapExcessMinor: 0,
        globalCapExcessMinor: 0,
        manualAdjustmentMinor: 0,
        manualExcessMinor: 0,
        afterItemCapMinor: grossMinor,
        afterPartyCapMinor: grossMinor,
        afterCoverageCapMinor: grossMinor,
        insurerMinor: grossMinor,
        insuredMinor: 0,
      };
      const coverage = party.coverages[coverageId(item.id)] ?? {};
      const partyDeductibleAllocation = partyDeductibleAllocations.get(party.id)?.[itemIndex] ?? 0;
      const globalDeductibleAllocation = globalDeductibleCellAllocations.get(party.id)?.[itemIndex] ?? 0;
      const beforeCoverageDeductible = cell.grossMinor - partyDeductibleAllocation - globalDeductibleAllocation;
      const coverageDeductible = Math.min(beforeCoverageDeductible, coverage.deductibleMinor ?? 0);
      cell.deductibleAppliedMinor = partyDeductibleAllocation + coverageDeductible;
      cell.afterDeductibleMinor = cell.grossMinor - cell.deductibleAppliedMinor;
      cell.insurerMinor = cell.afterDeductibleMinor;
      cells.push(cell);
    });
  });

  let stageCells = cells.map((cell) => ({ ...cell }));
  applyStage(stageCells, (cell) => cell.afterDeductibleMinor, (cell, amount, excess) => { cell.insurerMinor = amount; cell.itemCapExcessMinor = excess; }, (cell) => cell.itemId, (key) => items.find((item) => item.id === key)?.capMinor);
  for (const cell of stageCells) cell.afterItemCapMinor = cell.insurerMinor;
  applyStage(stageCells, (cell) => cell.afterItemCapMinor, (cell, amount, excess) => {
    cell.insurerMinor = amount;
    cell.partyCapExcessMinor = excess;
    cell.itemCapExcessMinor += cell.afterItemCapMinor - amount - excess;
  }, (cell) => cell.partyId, (partyId) => parties.find((party) => party.id === partyId)?.capMinor);
  for (const cell of stageCells) cell.afterPartyCapMinor = cell.insurerMinor;
  applyStage(stageCells, (cell) => cell.afterPartyCapMinor, (cell, amount, excess) => {
    cell.insurerMinor = amount;
    cell.coverageCapExcessMinor = excess;
    cell.partyCapExcessMinor += cell.afterPartyCapMinor - amount - excess;
  }, (cell) => `${cell.partyId}:${cell.coverageId}`, (key) => {
    const [partyId, coverage] = key.split(':');
    return parties.find((party) => party.id === partyId)?.coverages[coverage]?.capMinor;
  });
  for (const cell of stageCells) cell.afterCoverageCapMinor = cell.insurerMinor;
  if (globalCapMinor !== undefined) {
    const beforeTotal = sum(stageCells.map((cell) => cell.afterCoverageCapMinor));
    const amounts = allocateLargestRemainder(Math.min(beforeTotal, globalCapMinor), stageCells.map((cell) => cell.afterCoverageCapMinor), 'global cap');
    stageCells.forEach((cell, cellIndex) => {
      cell.globalCapExcessMinor = cell.afterCoverageCapMinor - amounts[cellIndex];
      cell.insurerMinor = amounts[cellIndex];
    });
  }
  for (const cell of stageCells) {
    cell.itemCapExcessMinor = Math.max(0, cell.itemCapExcessMinor);
    cell.partyCapExcessMinor = Math.max(0, cell.partyCapExcessMinor);
    cell.coverageCapExcessMinor = Math.max(0, cell.coverageCapExcessMinor);
  }

  for (const party of parties) {
    if (party.insurerOverrideMinor === undefined) continue;
    const partyCells = stageCells.filter((cell) => cell.partyId === party.id);
    const current = sum(partyCells.map((cell) => cell.insurerMinor));
    const maximum = sum(partyCells.map((cell) => cell.afterDeductibleMinor));
    if (party.insurerOverrideMinor > maximum) throw new Error(`manual insurer amount for ${party.id} cannot exceed its loss after deductible`);
    const target = party.insurerOverrideMinor;
    const delta = target - current;
    if (delta > 0) {
      const available = partyCells.map((cell) => cell.itemCapExcessMinor + cell.partyCapExcessMinor + cell.coverageCapExcessMinor + cell.globalCapExcessMinor);
      if (delta > sum(available)) throw new Error(`manual insurer amount for ${party.id} cannot exceed its capped loss`);
      const increments = allocateLargestRemainder(delta, available, `manual adjustment for ${party.id}`);
      partyCells.forEach((cell, cellIndex) => {
        let increment = increments[cellIndex];
        const stages: Array<'globalCapExcessMinor' | 'coverageCapExcessMinor' | 'partyCapExcessMinor' | 'itemCapExcessMinor'> = ['globalCapExcessMinor', 'coverageCapExcessMinor', 'partyCapExcessMinor', 'itemCapExcessMinor'];
        for (const stage of stages) {
          const used = Math.min(increment, cell[stage]);
          cell[stage] -= used;
          increment -= used;
        }
        cell.manualAdjustmentMinor += increments[cellIndex];
        cell.insurerMinor += increments[cellIndex];
      });
    } else if (delta < 0) {
      const reductions = allocateLargestRemainder(-delta, partyCells.map((cell) => cell.insurerMinor), `manual reduction for ${party.id}`);
      partyCells.forEach((cell, cellIndex) => {
        cell.manualAdjustmentMinor -= reductions[cellIndex];
        cell.manualExcessMinor += reductions[cellIndex];
        cell.insurerMinor -= reductions[cellIndex];
      });
    }
  }

  for (const cell of stageCells) {
    if (cell.insurerMinor < 0 || cell.insurerMinor > cell.afterDeductibleMinor) throw new Error(`insurer allocation for ${cell.partyId}/${cell.itemId} escaped its deductible range`);
    cell.insuredMinor = cell.grossMinor - cell.insurerMinor;
  }
  const outputCells: AdjustmentCell[] = stageCells.map((cell) => ({
    partyId: cell.partyId,
    itemId: cell.itemId,
    liabilityShareMinor: cell.liabilityShareMinor,
    grossMinor: cell.grossMinor,
    deductibleAppliedMinor: cell.deductibleAppliedMinor,
    afterDeductibleMinor: cell.afterDeductibleMinor,
    itemCapExcessMinor: cell.itemCapExcessMinor,
    partyCapExcessMinor: cell.partyCapExcessMinor,
    coverageCapExcessMinor: cell.coverageCapExcessMinor,
    globalCapExcessMinor: cell.globalCapExcessMinor,
    manualAdjustmentMinor: cell.manualAdjustmentMinor,
    manualExcessMinor: cell.manualExcessMinor,
    insurerMinor: cell.insurerMinor,
    insuredMinor: cell.insuredMinor,
  }));

  const partyResults: AdjustmentPartyResult[] = parties.map((party) => {
    const partyCells = outputCells.filter((cell) => cell.partyId === party.id);
    const insurerMinor = sum(partyCells.map((cell) => cell.insurerMinor));
    const grossMinor = sum(partyCells.map((cell) => cell.grossMinor));
    const deductibleAppliedMinor = sum(partyCells.map((cell) => cell.deductibleAppliedMinor));
    const paidMinor = paid.get(party.id) ?? 0;
    const nominal = party.deductibleMinor
      ?? (Object.values(party.coverages).some((terms) => terms.deductibleMinor !== undefined) ? sum(Object.values(party.coverages).map((terms) => terms.deductibleMinor ?? 0)) : (globalAllocations.get(party.id) ?? 0));
    const hasCoverageDeductible = partyCells.some((cell) => party.coverages[cell.itemId]?.deductibleMinor !== undefined);
    const deductibleSource: AdjustmentPartyResult['deductibleSource'] = hasCoverageDeductible || party.deductibleMinor !== undefined
      ? party.deductibleMinor !== undefined && hasCoverageDeductible ? 'coverage' : hasCoverageDeductible ? 'coverage' : 'party'
      : 'global';
    return {
      partyId: party.id,
      liabilityShare: liabilityShares[party.id],
      grossMinor,
      deductibleNominalMinor: nominal,
      deductibleSource,
      capMinor: party.capMinor,
      deductibleAppliedMinor,
      deductibleUnusedMinor: Math.max(0, nominal - deductibleAppliedMinor),
      afterDeductibleMinor: sum(partyCells.map((cell) => cell.afterDeductibleMinor)),
      itemCapExcessMinor: sum(partyCells.map((cell) => cell.itemCapExcessMinor)),
      partyCapExcessMinor: sum(partyCells.map((cell) => cell.partyCapExcessMinor)),
      coverageCapExcessMinor: sum(partyCells.map((cell) => cell.coverageCapExcessMinor)),
      globalCapExcessMinor: sum(partyCells.map((cell) => cell.globalCapExcessMinor)),
      manualAdjustmentMinor: sum(partyCells.map((cell) => cell.manualAdjustmentMinor)),
      manualExcessMinor: sum(partyCells.map((cell) => cell.manualExcessMinor)),
      insurerMinor,
      insuredMinor: grossMinor - insurerMinor,
      paidMinor,
      outstandingMinor: Math.max(0, insurerMinor - paidMinor),
      overpaidMinor: Math.max(0, paidMinor - insurerMinor),
    };
  });
  const itemResults = items.map((item) => {
    const itemCells = outputCells.filter((cell) => cell.itemId === item.id);
    const grossMinor = sum(itemCells.map((cell) => cell.grossMinor));
    const insurerMinor = sum(itemCells.map((cell) => cell.insurerMinor));
    return {
      itemId: item.id,
      grossMinor,
      capMinor: item.capMinor,
      deductibleAppliedMinor: sum(itemCells.map((cell) => cell.deductibleAppliedMinor)),
      insurerMinor,
      insuredMinor: grossMinor - insurerMinor,
      itemCapExcessMinor: sum(itemCells.map((cell) => cell.itemCapExcessMinor)),
      partyCapExcessMinor: sum(itemCells.map((cell) => cell.partyCapExcessMinor)),
      coverageCapExcessMinor: sum(itemCells.map((cell) => cell.coverageCapExcessMinor)),
      globalCapExcessMinor: sum(itemCells.map((cell) => cell.globalCapExcessMinor)),
      manualAdjustmentMinor: sum(itemCells.map((cell) => cell.manualAdjustmentMinor)),
      manualExcessMinor: sum(itemCells.map((cell) => cell.manualExcessMinor)),
    };
  });

  const approvedMinor = sum(outputCells.map((cell) => cell.insurerMinor));
  const paidMinor = sum(partyResults.map((party) => party.paidMinor));
  const overpaidMinor = sum(partyResults.map((party) => party.overpaidMinor));
  const outstandingMinor = sum(partyResults.map((party) => party.outstandingMinor));
  const deductibleAppliedMinor = sum(outputCells.map((cell) => cell.deductibleAppliedMinor));
  const itemCapExcessMinor = sum(outputCells.map((cell) => cell.itemCapExcessMinor));
  const partyCapExcessMinor = sum(outputCells.map((cell) => cell.partyCapExcessMinor));
  const coverageCapExcessMinor = sum(outputCells.map((cell) => cell.coverageCapExcessMinor));
  const globalCapExcessMinor = sum(outputCells.map((cell) => cell.globalCapExcessMinor));
  const manualAdjustmentMinor = sum(outputCells.map((cell) => cell.manualAdjustmentMinor));
  const manualExcessMinor = sum(outputCells.map((cell) => cell.manualExcessMinor));
  const basis = input.basis ?? (input.manual || parties.some((party) => party.insurerOverrideMinor !== undefined) ? 'manual' : 'calculated');
  const source = input.differenceSource ?? basis;
  const differences = buildDifferences(input.previous, {
    basis,
    currency: input.currency ?? 'CNY',
    grossMinor: totalGross,
    globalDeductibleNominalMinor,
    globalCapMinor,
    liabilityShares,
    approvedMinor,
    deductibleAppliedMinor,
    itemCapExcessMinor,
    partyCapExcessMinor,
    coverageCapExcessMinor,
    globalCapExcessMinor,
    manualAdjustmentMinor,
    manualExcessMinor,
    partyResults,
    itemResults,
    source,
  });

  const reconciliation: AdjustmentResult['reconciliation'] = {
    grossMinor: totalGross,
    insurerMinor: approvedMinor,
    insuredMinor: totalGross - approvedMinor,
    deductibleAppliedMinor,
    itemCapExcessMinor,
    partyCapExcessMinor,
    coverageCapExcessMinor,
    globalCapExcessMinor,
    manualAdjustmentMinor,
    manualExcessMinor,
    paidMinor,
    outstandingMinor,
    overpaidMinor,
    roundingResidualMinor: 0,
    unallocatedPaidMinor: 0,
  };
  const result: AdjustmentResult = {
    basis,
    currency: input.currency ?? 'CNY',
    grossMinor: totalGross,
    globalDeductibleNominalMinor,
    globalCapMinor,
    liabilityShares,
    cells: outputCells,
    parties: partyResults,
    items: itemResults,
    approvedMinor,
    insuredResponsibilityMinor: totalGross - approvedMinor,
    deductibleAppliedMinor,
    itemCapExcessMinor,
    partyCapExcessMinor,
    coverageCapExcessMinor,
    globalCapExcessMinor,
    manualAdjustmentMinor,
    manualExcessMinor,
    paidMinor,
    outstandingMinor,
    overpaidMinor,
    unallocatedPaidMinor: 0,
    roundingResidualMinor: 0,
    differences,
    differenceSources: [...new Set(differences.map((difference) => difference.source))],
    reconciliation,
  };
  assertConservation(result);
  return result;
}

function amountDiff(code: AdjustmentDifferenceCode, before: number | undefined, after: number | undefined, source: string, field: string, partyId?: string): AdjustmentDifference | undefined {
  if (before === undefined || after === undefined || before === after) return undefined;
  return { code, partyId, field, before, after, deltaMinor: after - before, source };
}
function buildDifferences(previous: AdjustmentResult | undefined, current: {
  basis: AdjustmentResult['basis'];
  currency: string;
  grossMinor: number;
  globalDeductibleNominalMinor: number;
  globalCapMinor?: number;
  liabilityShares: Record<string, number>;
  approvedMinor: number;
  deductibleAppliedMinor: number;
  itemCapExcessMinor: number;
  partyCapExcessMinor: number;
  coverageCapExcessMinor: number;
  globalCapExcessMinor: number;
  manualAdjustmentMinor: number;
  manualExcessMinor: number;
  partyResults: AdjustmentPartyResult[];
  itemResults: AdjustmentResult['items'];
  source: string;
}): AdjustmentDifference[] {
  if (!previous) return [];
  const differences: AdjustmentDifference[] = [];
  const add = (difference: AdjustmentDifference | undefined) => { if (difference) differences.push(difference); };
  add(amountDiff('loss-changed', previous.grossMinor, current.grossMinor, current.source, 'grossMinor'));
  add(amountDiff('deductible-changed', previous.globalDeductibleNominalMinor, current.globalDeductibleNominalMinor, current.source, 'globalDeductibleNominalMinor'));
  add(amountDiff('cap-changed', previous.globalCapMinor, current.globalCapMinor, current.source, 'globalCapMinor'));

  const previousParties = new Map(previous.parties.map((party) => [party.partyId, party]));
  for (const partyId of previous.liabilityShares ? Object.keys(previous.liabilityShares) : []) {
    if (!current.liabilityShares[partyId]) differences.push({ code: 'party-removed', partyId, before: partyId, source: current.source });
  }
  for (const partyId of Object.keys(current.liabilityShares)) {
    if (!previous.liabilityShares[partyId]) differences.push({ code: 'party-added', partyId, after: partyId, source: current.source });
  }
  for (const [partyId, share] of Object.entries(current.liabilityShares)) {
    const beforeShare = previous.liabilityShares[partyId];
    if (beforeShare !== undefined && Math.abs(beforeShare - share) > EPSILON) differences.push({ code: 'liability-share-changed', partyId, before: beforeShare, after: share, source: current.source });
  }
  for (const party of current.partyResults) {
    const old = previousParties.get(party.partyId);
    if (!old) continue;
    if (old.deductibleSource === party.deductibleSource && party.deductibleSource !== 'global') add(amountDiff('deductible-changed', old.deductibleNominalMinor, party.deductibleNominalMinor, current.source, 'deductibleNominalMinor', party.partyId));
    add(amountDiff('cap-changed', old.capMinor, party.capMinor, current.source, 'capMinor', party.partyId));
    if (party.overpaidMinor > 0) differences.push({ code: 'payment-overpaid', partyId: party.partyId, before: old.paidMinor, after: party.paidMinor, deltaMinor: party.overpaidMinor, source: current.source });
  }
  for (const item of current.itemResults) {
    const oldItem = previous.items.find((candidate) => candidate.itemId === item.itemId);
    if (oldItem) add(amountDiff('cap-changed', oldItem.capMinor, item.capMinor, current.source, 'itemCapMinor', item.itemId));
  }
  if (current.manualAdjustmentMinor !== 0 || current.basis === 'manual') differences.push({ code: 'manual-adjustment', before: previous.approvedMinor, after: current.approvedMinor, deltaMinor: current.approvedMinor - previous.approvedMinor, source: current.source });
  return differences;
}

export function assertConservation(result: AdjustmentResult): void {
  const cellGross = sum(result.cells.map((cell) => cell.grossMinor));
  const partyGross = sum(result.parties.map((party) => party.grossMinor));
  const itemGross = sum(result.items.map((item) => item.grossMinor));
  if (cellGross !== result.grossMinor || partyGross !== result.grossMinor || itemGross !== result.grossMinor) throw new Error('gross allocation is not conserved');
  for (const cell of result.cells) {
    if (cell.grossMinor !== cell.insurerMinor + cell.insuredMinor) throw new Error(`party ${cell.partyId} item ${cell.itemId} does not reconcile gross loss`);
    const expectedInsurer = cell.afterDeductibleMinor - cell.itemCapExcessMinor - cell.partyCapExcessMinor - cell.coverageCapExcessMinor - cell.globalCapExcessMinor - cell.manualExcessMinor;
    if (cell.insurerMinor !== expectedInsurer) throw new Error(`party ${cell.partyId} item ${cell.itemId} insurer amount does not reconcile deductible and caps`);
    if (cell.insurerMinor < 0 || cell.insurerMinor > cell.grossMinor) throw new Error(`party ${cell.partyId} item ${cell.itemId} insurer amount is outside its loss share`);
  }
  for (const party of result.parties) {
    if (party.insurerMinor !== sum(result.cells.filter((cell) => cell.partyId === party.partyId).map((cell) => cell.insurerMinor))) throw new Error(`party ${party.partyId} insurer total does not match line cells`);
    if (party.paidMinor !== party.insurerMinor - party.outstandingMinor + party.overpaidMinor) throw new Error(`party ${party.partyId} payment reconciliation failed`);
  }
  const totalPaid = sum(result.parties.map((party) => party.paidMinor));
  const totalOutstanding = sum(result.parties.map((party) => party.outstandingMinor));
  const totalOverpaid = sum(result.parties.map((party) => party.overpaidMinor));
  if (totalPaid !== result.paidMinor || totalOutstanding !== result.outstandingMinor || totalOverpaid !== result.overpaidMinor) throw new Error('payment allocation is not conserved');
  if (result.paidMinor !== result.approvedMinor - result.outstandingMinor + result.overpaidMinor) throw new Error('approved and paid amounts do not reconcile');
  const allocatedAfterLoss = result.deductibleAppliedMinor + result.itemCapExcessMinor + result.partyCapExcessMinor + result.coverageCapExcessMinor + result.globalCapExcessMinor + result.manualExcessMinor + result.approvedMinor;
  if (allocatedAfterLoss !== result.grossMinor) throw new Error('deductibles, caps, exclusions and insurer payments do not reconcile gross loss');
  if (result.roundingResidualMinor !== 0 || result.reconciliation.roundingResidualMinor !== 0) throw new Error('rounding residual must be allocated, not discarded');
}

export function paidByPartyFromEntries(entries: PaymentEntry[], partyIds: string[]): Record<string, number> {
  const totals = new Map(partyIds.map((id) => [id, 0]));
  let unallocated = 0;
  for (const entry of entries.filter((payment) => payment.status === 'posted')) {
    if (entry.allocations?.length) {
      for (const allocation of entry.allocations) {
        if (!totals.has(allocation.partyId)) unallocated += allocation.minor;
        else totals.set(allocation.partyId, (totals.get(allocation.partyId) ?? 0) + allocation.minor);
      }
    } else {
      unallocated += entry.amount.minor;
    }
  }
  return Object.fromEntries([...totals, ['__unallocated__', unallocated]]);
}

export function claimToAdjustmentInput(claim: ClaimState, request: CalculateAdjustmentInput = {}): CalculateAdjustmentInput {
  const loss: LossEstimate = claim.loss ?? { currency: 'CNY', gross: 0 };
  const previous = claim.adjustments.find((record) => record.id === claim.currentAdjustmentId);
  const adjustmentPartyIds = request.parties?.map((party) => party.id) ?? loss.parties?.map((party) => party.id);
  const paymentPartyIds = previous?.parties.map((party) => party.partyId) ?? adjustmentPartyIds ?? ['party-1'];
  const paidMap = paidByPartyFromEntries(claim.payments, paymentPartyIds);
  const unallocated = paidMap.__unallocated__ ?? 0;
  delete paidMap.__unallocated__;
  if (unallocated !== 0) {
    const fallbackParties = previous?.parties
      ?? paymentPartyIds.map((partyId) => ({ partyId, insurerMinor: unallocated }));
    const fallback = allocatePayment(unallocated, fallbackParties, 'unallocated payment');
    for (const allocation of fallback) paidMap[allocation.partyId] = (paidMap[allocation.partyId] ?? 0) + allocation.minor;
  }
  return {
    currency: request.currency ?? loss.currency,
    gross: request.gross ?? loss.gross,
    deductible: request.deductible,
    deductibleMinor: request.deductibleMinor ?? loss.deductibleMinor ?? (loss.deductible === undefined ? claim.policy?.deductibleMinor : undefined),
    cap: request.cap,
    capMinor: request.capMinor ?? loss.capMinor ?? (loss.cap === undefined ? claim.policy?.limitMinor : undefined),
    liabilityShare: request.liabilityShare ?? loss.liabilityShare,
    parties: request.parties ?? loss.parties?.map((party) => ({ ...party })),
    items: request.items ?? loss.items?.map((item) => ({ ...item })),
    paidMinorByParty: paidMap,
    previous,
    request: request.request ?? {},
    ...('manual' in request ? { manual: request.manual } : {}),
    ...('basis' in request ? { basis: request.basis } : {}),
    ...('differenceSource' in request ? { differenceSource: request.differenceSource } : {}),
  };
}
