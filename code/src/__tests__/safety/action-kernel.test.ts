import { describe, expect, it } from "vitest";
import {
  evaluateHelpAction,
  createActionReceipt,
  verifyActionReceipt,
  type HelpActionRequest,
} from "@/lib/safety/action-kernel";

const baseRequest: HelpActionRequest = {
  actionId: "refresh-diagnostics-cache",
  actorId: "emp-1",
  roleKey: "support",
  orgId: "org-1",
  locationId: "loc-1",
  reqId: "req-1",
};

describe("BUPOS Help Action Kernel", () => {
  it("allows read-only and safe local help actions without approval", () => {
    expect(evaluateHelpAction(baseRequest)).toMatchObject({
      verdict: "allow",
      band: "L1",
      reason: "Safe local help action allowed.",
    });

    expect(evaluateHelpAction({ ...baseRequest, actionId: "generate-support-packet" })).toMatchObject({
      verdict: "allow",
      band: "L0",
    });
  });

  it("requires manager approval for shift repair actions", () => {
    expect(evaluateHelpAction({ ...baseRequest, actionId: "review-open-shift-conflicts" })).toMatchObject({
      verdict: "require_approval",
      band: "L2",
      reason: "Manager approval required before any shift repair workflow.",
    });
  });

  it("denies high-risk payment, inventory, credential, and migration actions", () => {
    for (const actionId of [
      "change-inventory-quantity",
      "retry-payment-capture",
      "push-shopify-inventory",
      "run-database-migration",
      "change-credentials",
    ]) {
      expect(evaluateHelpAction({ ...baseRequest, actionId })).toMatchObject({
        verdict: "deny",
        band: "L3",
      });
    }
  });

  it("kill switch denies even otherwise safe actions", () => {
    expect(evaluateHelpAction(baseRequest, { killed: true, killedBy: "owner", killReason: "incident" })).toMatchObject({
      verdict: "deny",
      band: "L3",
      reason: "Help action kill switch is engaged by owner: incident",
    });
  });

  it("creates tamper-evident action receipts", () => {
    const decision = evaluateHelpAction(baseRequest);
    const receipt = createActionReceipt(baseRequest, decision, { outcome: "cache revalidated" });

    expect(receipt.kind).toBe("bupos-help-action-receipt");
    expect(verifyActionReceipt(receipt)).toBe(true);
    expect(receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const tampered = { ...receipt, decision: { ...receipt.decision, verdict: "allow" as const, reason: "changed" } };
    expect(verifyActionReceipt(tampered)).toBe(false);
  });
});
