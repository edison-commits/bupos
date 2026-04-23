import { NextResponse } from "next/server";
import { withDualAuth } from "@/lib/api/with-auth";
import { orgQuery } from "@/lib/supabase-rest";
import { validateBody, emailReceiptSchema } from "@/lib/validation/schemas";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { escapeHtml } from "@/lib/format/html-escape";

import { safeErr } from "@/lib/logging/safe-err";
/**
 * POST /api/email-receipt
 *
 * Sends a formatted receipt email via Resend.
 * Requires RESEND_API_KEY env var.
 * Free tier: 100 emails/day — plenty for a single register store.
 *
 * Body: {
 *   to: string (email address)
 *   transactionId: string
 * }
 *
 * The remaining fields (items, totals, tenders) are loaded server-side
 * from the transaction record to prevent client-supplied data forgery.
 */
export const POST = withDualAuth("register.open", async (req, ctx) => {
  try {
    const { orgId, employee } = ctx;

    // Rate-limit per employee to prevent abusing the endpoint as an email
    // bomber or burning the Resend free-tier 100/day quota.
    const rl = checkRateLimit(`email-receipt:${employee.id}`);
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many email-receipt requests. Try again later." }, { status: 429 });
    }

    const body = await req.json();
    const v = validateBody(emailReceiptSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { to, transactionId } = v.data;

    // R36-M1: per-transaction cap. Without this, a malicious cashier
    // could harass a legitimate customer by repeatedly triggering
    // receipt sends for the same transaction (each send is rate-
    // limited per employee, not per transaction). 3 sends per txn is
    // plenty for "lost the first one, please resend" flows while
    // stopping harassment at two re-sends.
    // check-pool-org-filter: scoped-by-prior-org-verified-transaction-id
    const { rows: priorSendRows } = await orgQuery(
      orgId,
      `SELECT COUNT(*)::int AS n
         FROM transaction_events
        WHERE transaction_id = $1
          AND event_kind = 'receipt_emailed'`,
      [transactionId],
    );
    const priorSends = Number((priorSendRows[0] as { n?: number })?.n ?? 0);
    if (priorSends >= 3) {
      return NextResponse.json(
        { error: "Receipt for this transaction has already been emailed too many times." },
        { status: 429 },
      );
    }

    // ── Load transaction from DB (C-04: never trust client-supplied items/totals) ──
    // Also scope by org and join the transaction's customer so we can verify
    // the recipient. Without that check, any cashier could send any
    // transaction's receipt to any email address — burning the Resend free
    // quota and enabling phishing under a trusted sender domain.
    const { rows: txnRows } = await orgQuery(
      orgId,
      `SELECT t.id, t.subtotal, t.discount_total, t.tax_total, t.grand_total, t.cart_snapshot, t.created_at,
              t.customer_id,
              o.name AS store_name,
              c.email AS customer_email
       FROM transactions t
       JOIN organizations o ON o.id = t.organization_id
       LEFT JOIN customers c ON c.id = t.customer_id
       WHERE t.id = $1 AND t.organization_id = $2`,
      [transactionId, orgId],
    );
    if (txnRows.length === 0) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    }
    // Recipient must match the customer on the transaction. Managers can
    // override with `?override=true` if the customer needs to forward the
    // receipt to a different address (rare — normally the receipt flow
    // happens at checkout with the customer present).
    const overrideAllowed = ["owner", "manager"].includes(employee.roleKey);
    const customerEmail = (txnRows[0].customer_email as string | null)?.toLowerCase() || null;
    const targetEmail = to.toLowerCase();
    const override = req.nextUrl.searchParams.get("override") === "true";
    if (!customerEmail) {
      if (!override || !overrideAllowed) {
        return NextResponse.json(
          { error: "Transaction has no customer on file. Manager override required to send to an arbitrary address." },
          { status: 403 },
        );
      }
    } else if (customerEmail !== targetEmail && !(override && overrideAllowed)) {
      return NextResponse.json(
        { error: "Email must match the customer on this transaction" },
        { status: 403 },
      );
    }

    // R36-M6: require step-up for override sends. A stolen manager
    // cookie could otherwise sweep every transaction's receipt to an
    // attacker-controlled address without any re-auth — a data-exfil
    // channel disguised as a legit receipt flow.
    if (override && overrideAllowed) {
      const { requireStepUp } = await import('@/lib/auth/step-up');
      const actorPassword = (body && typeof body === 'object') ? (body as { actorPassword?: string }).actorPassword : undefined;
      const stepUp = await requireStepUp({
        actorId: employee.id,
        orgId,
        actorPassword: typeof actorPassword === 'string' ? actorPassword : undefined,
        bucketKey: 'email-receipt-override-stepup',
      });
      if (!stepUp.ok) {
        return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
      }
    }
    const txn = txnRows[0] as Record<string, unknown>;
    const subtotal = Number(txn.subtotal ?? 0);
    const tax = Number(txn.tax_total ?? 0);
    const total = Number(txn.grand_total ?? 0);
    // R32-H11: sanitize the org-controlled storeName before it lands
    // in the Subject line. Resend's HTTP API JSON-quotes the value,
    // which blocks classic SMTP CRLF injection, but a Unicode-
    // override or raw newline can still produce phishing-ready
    // subjects ("Your receipt from Acme\n\n[blank]\n\nReset your
    // password: https://attacker.example" rendered as multi-line in
    // some email clients). Strip control chars + collapse to a single
    // line + cap length.
    const rawStoreName = (txn.store_name as string) || "BasicUniformPOS";
    // R32-H11 + R33-M-email-subj-unicode: strip ASCII control chars
    // (CR/LF/tab) AND Unicode line/paragraph separators (U+2028,
    // U+2029) and bidirectional format chars (U+202A-U+202E plus
    // U+200E/F) which some email clients render as newlines / can
    // spoof direction. `\p{C}` (Other) + `\p{Cf}` (format) in
    // unicode-aware mode covers the lot.
    const storeName = rawStoreName
      .replace(/[\p{C}\p{Cf}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const date = txn.created_at ? new Date(txn.created_at as string).toLocaleDateString() : new Date().toLocaleDateString();

    // Parse items from the stored cart_snapshot
    let cartSnapshot: Record<string, unknown> = {};
    try {
      cartSnapshot = typeof txn.cart_snapshot === "string" ? JSON.parse(txn.cart_snapshot as string) : (txn.cart_snapshot as Record<string, unknown>) ?? {};
    } catch { /* empty cart */ }
    const items = (Array.isArray(cartSnapshot.items) ? cartSnapshot.items : []) as { name?: string; productName?: string; qty?: number; quantity?: number; unitPrice?: number; overridePrice?: number; price?: number }[];

    // Load tenders from DB. Join through transactions so the org filter is
    // also enforced on the tender aggregate — defense in depth against a
    // future refactor that skips the prior `t.organization_id = $2` check.
    // check-pool-org-filter: scoped-by-prior-org-verified-transaction-id
    const { rows: tenderRows } = await orgQuery(
      orgId,
      `SELECT tt.tender_type, tt.amount
       FROM transaction_tenders tt
       JOIN transactions t ON t.id = tt.transaction_id AND t.organization_id = $2
       WHERE tt.transaction_id = $1`,
      [transactionId, orgId],
    );
    const tenders = tenderRows.map((r) => ({ type: (r as Record<string, unknown>).tender_type as string, amount: Number((r as Record<string, unknown>).amount) }));

    // Load loyalty points earned (from customers table delta or cart snapshot)
    const loyaltyEarned = Number(cartSnapshot.loyaltyPointsEarned ?? 0);

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[email-receipt] RESEND_API_KEY is not configured. Receipt NOT sent for txn:", transactionId);
      return NextResponse.json({ sent: false, error: "RESEND_API_KEY not configured" }, { status: 500 });
    }

    const fromEmail = process.env.RESEND_FROM_EMAIL || "receipts@basicuniformpos.com";

    // R39-A1-6: `esc` is the shared `escapeHtml` — imported at the top
    // of this module. Prior inline copy had the same 5-char coverage
    // but forked the implementation; a future tightening (e.g. adding
    // backtick for attribute-context XSS) would not propagate here.
    const esc = escapeHtml;

    // Build HTML receipt
    const itemHtmlRows = items.map((item) => {
      const name = item.name || item.productName || "Item";
      // R48: coerce qty through Number() before rendering. Prior shape
      // interpolated `item.qty ?? item.quantity ?? 1` verbatim. If the
      // value is a string containing HTML (e.g., a maliciously crafted
      // cart_snapshot written via offline sync or direct DB write),
      // the raw HTML renders in the customer email — stored-XSS via
      // image-onerror phishing. Coerce via Number + fallback to 1 on
      // NaN; arithmetic with (price * qty) below depended on numeric
      // coercion anyway.
      const qty = Number(item.qty ?? item.quantity ?? 1);
      const safeQty = Number.isFinite(qty) ? qty : 1;
      const price = item.overridePrice ?? item.unitPrice ?? item.price ?? 0;
      return `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #f0f0f0;">${esc(String(name))}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:center;">${safeQty}</td>
        <td style="padding:6px 0;border-bottom:1px solid #f0f0f0;text-align:right;">$${(price * safeQty).toFixed(2)}</td>
      </tr>`;
    }).join("");

    const tenderHtmlRows = tenders.map((t) =>
      `<div style="display:flex;justify-content:space-between;padding:2px 0;">
        <span style="text-transform:capitalize;">${t.type === "store_credit" ? "Store credit" : esc(t.type)}</span>
        <span>$${t.amount.toFixed(2)}</span>
      </div>`
    ).join("");

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background-color:#f5f5f5;">
  <div style="max-width:480px;margin:0 auto;padding:24px;">
    <div style="background:white;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

      <!-- Header -->
      <div style="background:#18181b;color:white;padding:24px;text-align:center;">
        <h1 style="margin:0;font-size:20px;font-weight:700;">${esc(storeName)}</h1>
        <p style="margin:8px 0 0;font-size:13px;opacity:0.7;">Receipt</p>
      </div>

      <!-- Meta -->
      <div style="padding:20px 24px;border-bottom:1px solid #f0f0f0;">
        <div style="display:flex;justify-content:space-between;font-size:13px;color:#71717a;">
          <span>Transaction</span>
          <span style="font-family:monospace;">#${transactionId.slice(0, 8).toUpperCase()}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;color:#71717a;margin-top:4px;">
          <span>Date</span>
          <span>${date}</span>
        </div>
      </div>

      <!-- Items -->
      <div style="padding:16px 24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <thead>
            <tr style="color:#71717a;font-size:12px;">
              <th style="text-align:left;padding:0 0 8px;font-weight:500;">Item</th>
              <th style="text-align:center;padding:0 8px 8px;font-weight:500;">Qty</th>
              <th style="text-align:right;padding:0 0 8px;font-weight:500;">Amount</th>
            </tr>
          </thead>
          <tbody>${itemHtmlRows}</tbody>
        </table>
      </div>

      <!-- Totals -->
      <div style="padding:16px 24px;background:#fafafa;border-top:1px solid #f0f0f0;">
        <div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;">
          <span>Subtotal</span><span>$${subtotal.toFixed(2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;color:#71717a;">
          <span>Tax</span><span>$${tax.toFixed(2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:700;padding:12px 0 4px;border-top:2px solid #18181b;margin-top:8px;">
          <span>Total</span><span>$${total.toFixed(2)}</span>
        </div>
      </div>

      <!-- Tenders -->
      <div style="padding:12px 24px;font-size:13px;color:#71717a;border-top:1px solid #f0f0f0;">
        <p style="margin:0 0 4px;font-weight:600;color:#18181b;">Payment</p>
        ${tenderHtmlRows}
      </div>

      ${loyaltyEarned > 0 ? `
      <!-- Loyalty -->
      <div style="padding:12px 24px;border-top:1px solid #f0f0f0;">
        <div style="background:#ecfdf5;border-radius:8px;padding:10px 14px;font-size:13px;color:#065f46;">
          You earned <strong>${loyaltyEarned} loyalty points</strong> on this purchase!
        </div>
      </div>
      ` : ""}

      <!-- Footer -->
      <div style="padding:16px 24px;text-align:center;font-size:12px;color:#a1a1aa;border-top:1px solid #f0f0f0;">
        <p style="margin:0;">Thank you for shopping with us!</p>
        <p style="margin:4px 0 0;">This is your digital receipt. No need to print.</p>
      </div>

    </div>
  </div>
</body>
</html>`;

    // Send via Resend API — 15 s timeout prevents hung connections from blocking the response
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject: `Your receipt from ${storeName} — #${transactionId.slice(0, 8).toUpperCase()}`,
        html,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error("[email-receipt] Resend error:", safeErr(err));
      // C-03: Do not leak error details to client
      return NextResponse.json({ error: "Failed to send email" }, { status: 502 });
    }

    const result = await response.json();

    // R36-M1: record the send so the per-transaction cap above can
    // read it on the next call. Best-effort — a failed insert doesn't
    // rollback the real send (Resend already accepted the message),
    // but a failed insert also means a future POST won't see this as
    // a prior send, so the cap slightly widens. Live with it rather
    // than fail the user-facing call.
    try {
      await orgQuery(
        orgId,
        `INSERT INTO transaction_events (id, transaction_id, actor_employee_id, event_kind, payload)
         VALUES (gen_random_uuid(), $1, $2, 'receipt_emailed', $3)`,
        [
          transactionId,
          employee.id,
          JSON.stringify({
            to: targetEmail,
            override: override && overrideAllowed ? "true" : "false",
            provider_id: result.id ?? null,
          }),
        ],
      );
    } catch (e) {
      console.error("[email-receipt] failed to record receipt_emailed event:", safeErr(e));
    }

    return NextResponse.json({ sent: true, provider: "resend", id: result.id });
  } catch (err) {
    console.error("POST /api/email-receipt error:", safeErr(err));
    return NextResponse.json({ error: "Failed to send receipt email" }, { status: 500 });
  }
});
