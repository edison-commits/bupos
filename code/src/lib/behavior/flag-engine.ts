/**
 * Behavior flag engine — analyzes transaction data from the JSON store
 * and generates advisory behavior flags for employees.
 *
 * Each rule function returns zero or more flag descriptors that can be
 * persisted in the behaviorFlags array.
 */

import type { EmployeeBehaviorFlag, BehaviorFlagSeverity } from "@/lib/domain/types";
import type { LocalStoreData } from "@/lib/persistence/types";
import { formatCurrency } from "@/lib/format";

export interface FlagDescriptor {
  employeeId: string;
  locationId?: string;
  flagType: string;
  severity: BehaviorFlagSeverity;
  title: string;
  description: string;
  sourceRefType?: string;
  sourceRefId?: string;
  details: Record<string, unknown>;
}

// ── Rule: High void/cancel rate ──────────────────────────────────────

function ruleHighVoidRate(store: LocalStoreData): FlagDescriptor[] {
  const flags: FlagDescriptor[] = [];
  const voidKinds = new Set(["cart_voided", "transaction_voided", "item_removed"]);

  // Count void events per employee
  const voidsByEmployee = new Map<string, number>();
  const totalByEmployee = new Map<string, number>();

  for (const evt of store.transactionEventPlaceholders) {
    totalByEmployee.set(evt.actorEmployeeId, (totalByEmployee.get(evt.actorEmployeeId) ?? 0) + 1);
    if (voidKinds.has(evt.eventKind as string)) {
      voidsByEmployee.set(evt.actorEmployeeId, (voidsByEmployee.get(evt.actorEmployeeId) ?? 0) + 1);
    }
  }

  // Calculate store average void rate
  let totalVoids = 0;
  let totalEvents = 0;
  for (const [, v] of voidsByEmployee) totalVoids += v;
  for (const [, v] of totalByEmployee) totalEvents += v;
  const avgVoidRate = totalEvents > 0 ? totalVoids / totalEvents : 0;

  for (const [empId, voids] of voidsByEmployee) {
    const total = totalByEmployee.get(empId) ?? 0;
    if (total < 5) continue; // Need minimum activity
    const rate = voids / total;
    if (rate > avgVoidRate * 2 && voids >= 3) {
      const severity: BehaviorFlagSeverity = rate > avgVoidRate * 3 ? "high" : rate > avgVoidRate * 2 ? "medium" : "low";
      flags.push({
        employeeId: empId,
        flagType: "high_void_rate",
        severity,
        title: "Elevated void/cancel rate",
        description: `Void rate ${(rate * 100).toFixed(1)}% is ${(rate / avgVoidRate).toFixed(1)}x the store average of ${(avgVoidRate * 100).toFixed(1)}%.`,
        details: { voidCount: voids, totalEvents: total, voidRate: rate, storeAverage: avgVoidRate },
      });
    }
  }
  return flags;
}

// ── Rule: Repeated post-total cancellations ──────────────────────────

function rulePostTotalCancellations(store: LocalStoreData): FlagDescriptor[] {
  const flags: FlagDescriptor[] = [];

  // Look for events where a cart was voided after total_calculated
  const cancelsAfterTotal = new Map<string, number>();
  const txnHadTotal = new Set<string>();

  for (const evt of store.transactionEventPlaceholders) {
    if (evt.eventKind === ("total_calculated" as string)) {
      txnHadTotal.add(evt.transactionId);
    }
    if ((evt.eventKind === ("cart_voided" as string) || evt.eventKind === ("transaction_voided" as string)) && txnHadTotal.has(evt.transactionId)) {
      cancelsAfterTotal.set(evt.actorEmployeeId, (cancelsAfterTotal.get(evt.actorEmployeeId) ?? 0) + 1);
    }
  }

  for (const [empId, count] of cancelsAfterTotal) {
    if (count >= 2) {
      flags.push({
        employeeId: empId,
        flagType: "post_total_cancellations",
        severity: count >= 5 ? "high" : count >= 3 ? "medium" : "low",
        title: "Repeated post-total cancellations",
        description: `${count} cancellations occurred after the total was shown to the customer.`,
        details: { count },
      });
    }
  }
  return flags;
}

// ── Rule: Frequent manual price overrides ────────────────────────────

function ruleFrequentPriceOverrides(store: LocalStoreData): FlagDescriptor[] {
  const flags: FlagDescriptor[] = [];
  const overridesByEmployee = new Map<string, number>();

  for (const exc of store.transactionExceptionPlaceholders) {
    if (exc.exceptionCode === "manual_price_override_threshold") {
      // Find the event for this transaction to get the actor
      const evt = store.transactionEventPlaceholders.find((e) => e.transactionId === exc.transactionId);
      if (evt) {
        overridesByEmployee.set(evt.actorEmployeeId, (overridesByEmployee.get(evt.actorEmployeeId) ?? 0) + 1);
      }
    }
  }

  for (const [empId, count] of overridesByEmployee) {
    if (count >= 3) {
      flags.push({
        employeeId: empId,
        flagType: "frequent_price_overrides",
        severity: count >= 8 ? "high" : count >= 5 ? "medium" : "low",
        title: "Frequent manual price overrides",
        description: `${count} manual price override exceptions triggered.`,
        details: { count },
      });
    }
  }
  return flags;
}

// ── Rule: Elevated shift discrepancies ───────────────────────────────

function ruleShiftDiscrepancies(store: LocalStoreData): FlagDescriptor[] {
  const flags: FlagDescriptor[] = [];
  const varianceByEmployee = new Map<string, { shifts: number; totalAbsVariance: number; totalVariance: number }>();

  for (const shift of store.shifts) {
    if (shift.status !== "closed" || shift.closingVariance == null) continue;
    const existing = varianceByEmployee.get(shift.employeeId) ?? { shifts: 0, totalAbsVariance: 0, totalVariance: 0 };
    existing.shifts += 1;
    existing.totalAbsVariance += Math.abs(shift.closingVariance);
    existing.totalVariance += shift.closingVariance;
    varianceByEmployee.set(shift.employeeId, existing);
  }

  for (const [empId, data] of varianceByEmployee) {
    if (data.shifts < 2) continue;
    const avgAbsVariance = data.totalAbsVariance / data.shifts;
    if (avgAbsVariance > 2) {
      flags.push({
        employeeId: empId,
        flagType: "shift_discrepancies",
        severity: avgAbsVariance > 10 ? "high" : avgAbsVariance > 5 ? "medium" : "low",
        title: "Elevated shift cash discrepancies",
        description: `Average absolute variance of ${formatCurrency(avgAbsVariance)} across ${data.shifts} shifts. Net: ${formatCurrency(data.totalVariance)}.`,
        details: { shifts: data.shifts, avgAbsVariance, netVariance: data.totalVariance },
      });
    }
  }
  return flags;
}

// ── Rule: Unusual manual drawer opens ────────────────────────────────

function ruleManualDrawerOpens(store: LocalStoreData): FlagDescriptor[] {
  const flags: FlagDescriptor[] = [];
  const opensByEmployee = new Map<string, number>();

  for (const evt of store.transactionEventPlaceholders) {
    if (evt.eventKind === ("drawer_opened_manual" as string)) {
      opensByEmployee.set(evt.actorEmployeeId, (opensByEmployee.get(evt.actorEmployeeId) ?? 0) + 1);
    }
  }

  for (const [empId, count] of opensByEmployee) {
    if (count >= 3) {
      flags.push({
        employeeId: empId,
        flagType: "manual_drawer_opens",
        severity: count >= 8 ? "high" : count >= 5 ? "medium" : "low",
        title: "Unusual manual drawer opens",
        description: `${count} manual drawer open events recorded.`,
        details: { count },
      });
    }
  }
  return flags;
}

// ── Rule: Excessive gift card / store credit activity ────────────────

function ruleGiftCardActivity(store: LocalStoreData): FlagDescriptor[] {
  const flags: FlagDescriptor[] = [];
  const gcByEmployee = new Map<string, { activations: number; totalValue: number }>();

  for (const gc of store.giftCards) {
    if (gc.activatedBy) {
      const existing = gcByEmployee.get(gc.activatedBy) ?? { activations: 0, totalValue: 0 };
      existing.activations += 1;
      existing.totalValue += gc.initialBalance;
      gcByEmployee.set(gc.activatedBy, existing);
    }
  }

  for (const [empId, data] of gcByEmployee) {
    if (data.activations >= 5 || data.totalValue >= 500) {
      flags.push({
        employeeId: empId,
        flagType: "excessive_gift_card_activity",
        severity: data.totalValue >= 1000 ? "high" : data.totalValue >= 500 ? "medium" : "low",
        title: "Elevated gift card activation volume",
        description: `${data.activations} gift cards activated totaling ${formatCurrency(data.totalValue)}.`,
        details: { activations: data.activations, totalValue: data.totalValue },
      });
    }
  }

  // Store credit issuance by employee
  const scByEmployee = new Map<string, { issuances: number; totalValue: number }>();
  for (const entry of store.storeCreditLedger) {
    if (entry.transactionType === "issuance" && entry.employeeId) {
      const existing = scByEmployee.get(entry.employeeId) ?? { issuances: 0, totalValue: 0 };
      existing.issuances += 1;
      existing.totalValue += entry.amount;
      scByEmployee.set(entry.employeeId, existing);
    }
  }

  for (const [empId, data] of scByEmployee) {
    if (data.issuances >= 5 || data.totalValue >= 200) {
      flags.push({
        employeeId: empId,
        flagType: "excessive_store_credit_issuance",
        severity: data.totalValue >= 500 ? "high" : data.totalValue >= 200 ? "medium" : "low",
        title: "Elevated store credit issuance",
        description: `${data.issuances} store credit issuances totaling ${formatCurrency(data.totalValue)}.`,
        details: { issuances: data.issuances, totalValue: data.totalValue },
      });
    }
  }

  return flags;
}

// ── Main engine ──────────────────────────────────────────────────────

const ALL_RULES = [
  ruleHighVoidRate,
  rulePostTotalCancellations,
  ruleFrequentPriceOverrides,
  ruleShiftDiscrepancies,
  ruleManualDrawerOpens,
  ruleGiftCardActivity,
];

/**
 * Run all behavior rules against the store and return flag descriptors.
 * The caller is responsible for deduplicating against existing flags
 * and persisting new ones.
 */
export function generateBehaviorFlags(store: LocalStoreData): FlagDescriptor[] {
  const allFlags: FlagDescriptor[] = [];
  for (const rule of ALL_RULES) {
    allFlags.push(...rule(store));
  }
  return allFlags;
}

/**
 * Run rules and persist any new flags (deduplicating by employee + flagType).
 * Returns the list of newly created flags.
 */
export function generateAndPersistFlags(store: LocalStoreData): EmployeeBehaviorFlag[] {
  const descriptors = generateBehaviorFlags(store);
  const existing = new Set(store.behaviorFlags.map((f) => `${f.employeeId}::${f.flagType}`));
  const newFlags: EmployeeBehaviorFlag[] = [];
  const now = new Date().toISOString();

  for (const d of descriptors) {
    const key = `${d.employeeId}::${d.flagType}`;
    if (existing.has(key)) continue;

    const flag: EmployeeBehaviorFlag = {
      id: crypto.randomUUID(),
      organizationId: store.organization.id,
      employeeId: d.employeeId,
      locationId: d.locationId,
      flagType: d.flagType,
      severity: d.severity,
      title: d.title,
      description: d.description,
      sourceRefType: d.sourceRefType,
      sourceRefId: d.sourceRefId,
      details: d.details,
      isReviewed: false,
      createdAt: now,
    };

    store.behaviorFlags.push(flag);
    newFlags.push(flag);
    existing.add(key);
  }

  return newFlags;
}
