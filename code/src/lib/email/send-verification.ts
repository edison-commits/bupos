/**
 * R8-M-12 closed: send a signup verification email via Resend.
 *
 * Configuration:
 *   RESEND_API_KEY — Resend HTTP API key (prod required)
 *   RESEND_FROM    — "Name <address@domain>" (prod required)
 *   APP_URL        — full base URL for the verification link (prod required)
 *
 * Dev fallback: if any required env is missing, logs the verification link
 * to the console so local dev can still click through. NEVER swallows a
 * real send error in prod — throws so the signupAction can surface a
 * generic retry message without losing the audit trail.
 */

import { safeErr } from "@/lib/logging/safe-err";
import { escapeHtml } from "@/lib/format/html-escape";

export interface VerificationEmailParams {
  to: string;
  firstName: string;
  verificationUrl: string;
}

export async function sendVerificationEmail(params: VerificationEmailParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const isProd = process.env.NODE_ENV === "production";

  if (!apiKey || !from) {
    if (isProd) {
      throw new Error(
        "RESEND_API_KEY / RESEND_FROM must be configured in production for signup verification",
      );
    }
    // Dev: log the link so local testing works without Resend setup.
    console.warn("[sendVerificationEmail] Resend not configured; dev fallback:", {
      to: params.to,
      url: params.verificationUrl,
    });
    return;
  }

  const body = {
    from,
    to: [params.to],
    subject: "Confirm your BuPOS account",
    html: `
      <p>Hi ${escapeHtml(params.firstName)},</p>
      <p>Thanks for signing up for BuPOS. To activate your account, click the link below:</p>
      <p><a href="${escapeHtml(params.verificationUrl)}">Activate BuPOS account</a></p>
      <p>This link expires in 24 hours. If you didn't sign up, you can safely ignore this email.</p>
    `,
    text: `Hi ${params.firstName},\n\nThanks for signing up for BuPOS.\n\nActivate your account: ${params.verificationUrl}\n\nThis link expires in 24 hours.`,
  };

  try {
    // R25-ops-M-3: cap Resend at 15s. Without a timeout, a slow
    // Resend outage pins the signup request against the Worker CPU
    // budget (30s) and serves a generic 500. Matching the same limit
    // used by `/api/email-receipt` + `/api/eod-report`.
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Resend send failed (${resp.status}): ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.error("[sendVerificationEmail] Resend error:", safeErr(err));
    throw err;
  }
}

// R32-D4: inline escapeHtml removed — use the shared helper from
// @/lib/format/html-escape so every email template escapes identically
// and future edits to the helper propagate here too (R28-M5 intent).
