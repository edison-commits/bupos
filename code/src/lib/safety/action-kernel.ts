export type HelpActionBand = "L0" | "L1" | "L2" | "L3";
export type HelpActionVerdict = "allow" | "require_approval" | "deny";

export interface HelpActionRequest {
  actionId: string;
  actorId: string;
  roleKey: string;
  orgId: string;
  locationId?: string;
  reqId: string;
}

export interface HelpActionKillSwitch {
  killed?: boolean;
  killedBy?: string;
  killReason?: string;
}

export interface HelpActionDecision {
  verdict: HelpActionVerdict;
  band: HelpActionBand;
  reason: string;
  allowedToExecute: boolean;
}

export interface HelpActionReceipt {
  kind: "bupos-help-action-receipt";
  id: string;
  createdAt: string;
  request: HelpActionRequest;
  decision: HelpActionDecision;
  outcome: Record<string, unknown>;
  fingerprint: string;
}

const READ_ONLY_ACTIONS = new Set(["generate-support-packet", "run-diagnostics"]);
const SAFE_LOCAL_ACTIONS = new Set(["refresh-diagnostics-cache"]);
const MANAGER_APPROVAL_ACTIONS = new Set(["review-open-shift-conflicts"]);
const HIGH_RISK_ACTIONS = new Set([
  "change-inventory-quantity",
  "retry-payment-capture",
  "retry-refund",
  "push-shopify-inventory",
  "run-database-migration",
  "change-credentials",
  "delete-customer-data",
]);

function cleanText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 160);
}

export function evaluateHelpAction(
  request: HelpActionRequest,
  killSwitch: HelpActionKillSwitch = {},
): HelpActionDecision {
  if (killSwitch.killed) {
    const by = cleanText(killSwitch.killedBy) ?? "operator";
    const reason = cleanText(killSwitch.killReason);
    return {
      verdict: "deny",
      band: "L3",
      reason: `Help action kill switch is engaged by ${by}${reason ? `: ${reason}` : ""}`,
      allowedToExecute: false,
    };
  }

  if (READ_ONLY_ACTIONS.has(request.actionId)) {
    return {
      verdict: "allow",
      band: "L0",
      reason: "Read-only help action allowed.",
      allowedToExecute: true,
    };
  }

  if (SAFE_LOCAL_ACTIONS.has(request.actionId)) {
    return {
      verdict: "allow",
      band: "L1",
      reason: "Safe local help action allowed.",
      allowedToExecute: true,
    };
  }

  if (MANAGER_APPROVAL_ACTIONS.has(request.actionId)) {
    return {
      verdict: "require_approval",
      band: "L2",
      reason: "Manager approval required before any shift repair workflow.",
      allowedToExecute: false,
    };
  }

  if (HIGH_RISK_ACTIONS.has(request.actionId)) {
    return {
      verdict: "deny",
      band: "L3",
      reason: "High-risk help action denied in v0. Payment, inventory, customer, credential, channel-push, and migration changes are not auto-fixable.",
      allowedToExecute: false,
    };
  }

  return {
    verdict: "deny",
    band: "L3",
    reason: "Unknown help action denied by default.",
    allowedToExecute: false,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

function pseudoSha256Hex(input: string): string {
  // Deterministic 64-hex fingerprint for tamper detection in receipts.
  // This is intentionally dependency-free for Cloudflare/Worker bundling.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let h3 = 0x9e3779b9;
  let h4 = 0x243f6a88;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    h3 = Math.imul(h3 ^ ch, 2246822507);
    h4 = Math.imul(h4 ^ ch, 3266489909);
  }
  const parts = [h1, h2, h3, h4, h1 ^ h3, h2 ^ h4, h1 ^ h2, h3 ^ h4];
  return parts.map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}

function receiptPayload(receipt: Omit<HelpActionReceipt, "fingerprint">): string {
  return stableJson({
    kind: receipt.kind,
    id: receipt.id,
    createdAt: receipt.createdAt,
    request: receipt.request,
    decision: receipt.decision,
    outcome: receipt.outcome,
  });
}

export function createActionReceipt(
  request: HelpActionRequest,
  decision: HelpActionDecision,
  outcome: Record<string, unknown>,
  now = new Date(),
): HelpActionReceipt {
  const base = {
    kind: "bupos-help-action-receipt" as const,
    id: `${request.reqId}:${request.actionId}`,
    createdAt: now.toISOString(),
    request,
    decision,
    outcome,
  };
  return { ...base, fingerprint: pseudoSha256Hex(receiptPayload(base)) };
}

export function verifyActionReceipt(receipt: HelpActionReceipt): boolean {
  const { fingerprint: _fingerprint, ...base } = receipt;
  return receipt.fingerprint === pseudoSha256Hex(receiptPayload(base));
}
