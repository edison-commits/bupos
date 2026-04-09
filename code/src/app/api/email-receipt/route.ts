import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, getRegisterSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/authz";
import { validateBody, emailReceiptSchema } from "@/lib/validation/schemas";

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
 *   storeName: string
 *   items: { name: string; qty: number; price: number }[]
 *   subtotal: number
 *   tax: number
 *   total: number
 *   tenders: { type: string; amount: number }[]
 *   loyaltyEarned?: number
 *   date: string
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const [adminSession, registerSession] = await Promise.all([getAdminSession(), getRegisterSession()]);
    if (!adminSession?.employee && !registerSession?.employee) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (adminSession?.employee && !hasPermission(adminSession.employee.roleKey, "audit.view")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (registerSession?.employee && !hasPermission(registerSession.employee.roleKey, "register.open")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const v = validateBody(emailReceiptSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { to, transactionId, storeName, items, subtotal, tax, total, tenders, loyaltyEarned, date } = v.data;

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[email-receipt] RESEND_API_KEY is not configured. Receipt NOT sent to:", to, "txn:", transactionId);
      return NextResponse.json({ sent: false, error: "RESEND_API_KEY not configured" }, { status: 500 });
    }

    const fromEmail = process.env.RESEND_FROM_EMAIL || "receipts@basicuniformpos.com";

    // HTML escape helper to prevent XSS in user-controlled fields
    const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]!);

    // Build HTML receipt
    const itemRows = ((items || []) as { name: string; qty: number; price: number }[]).map((item) =>
      `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #f0f0f0;">${esc(item.name)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:center;">${item.qty}</td>
        <td style="padding:6px 0;border-bottom:1px solid #f0f0f0;text-align:right;">$${(item.price * item.qty).toFixed(2)}</td>
      </tr>`
    ).join("");

    const tenderRows = ((tenders || []) as { type: string; amount: number }[]).map((t) =>
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
        <h1 style="margin:0;font-size:20px;font-weight:700;">${esc(storeName || "BasicUniformPOS")}</h1>
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
          <span>${date || new Date().toLocaleDateString()}</span>
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
          <tbody>${itemRows}</tbody>
        </table>
      </div>

      <!-- Totals -->
      <div style="padding:16px 24px;background:#fafafa;border-top:1px solid #f0f0f0;">
        <div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;">
          <span>Subtotal</span><span>$${(subtotal ?? 0).toFixed(2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;color:#71717a;">
          <span>Tax</span><span>$${(tax ?? 0).toFixed(2)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:700;padding:12px 0 4px;border-top:2px solid #18181b;margin-top:8px;">
          <span>Total</span><span>$${(total ?? 0).toFixed(2)}</span>
        </div>
      </div>

      <!-- Tenders -->
      <div style="padding:12px 24px;font-size:13px;color:#71717a;border-top:1px solid #f0f0f0;">
        <p style="margin:0 0 4px;font-weight:600;color:#18181b;">Payment</p>
        ${tenderRows}
      </div>

      ${loyaltyEarned && loyaltyEarned > 0 ? `
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
        subject: `Your receipt from ${storeName || "BasicUniformPOS"} — #${transactionId.slice(0, 8).toUpperCase()}`,
        html,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error("[email-receipt] Resend error:", err);
      return NextResponse.json({ error: "Failed to send email", details: err }, { status: 502 });
    }

    const result = await response.json();
    return NextResponse.json({ sent: true, provider: "resend", id: result.id });
  } catch (err) {
    console.error("POST /api/email-receipt error:", err);
    return NextResponse.json({ error: "Failed to send receipt email" }, { status: 500 });
  }
}
