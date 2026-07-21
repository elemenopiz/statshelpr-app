/**
 * Resend transactional email — used only for the license-reset flow (LS has
 * no buyer-facing self-service portal/API for license-instance deactivation;
 * see routes/reset.ts for the verification notes).
 *
 * API: POST https://api.resend.com/emails
 *   headers: Authorization: Bearer <RESEND_API_KEY>, Content-Type: application/json
 *   body: { from, to: string[], subject, html }
 *   200/201: { id: string }
 *   4xx/5xx: { name, message } (or similar) — surfaced as `reason` here.
 *
 * Requires the RESEND_API_KEY secret (wrangler secret put RESEND_API_KEY) and
 * a verified sending domain in the Resend dashboard for the `from` address
 * below (statshelpr.com) — sends will fail (403) until that domain is
 * verified there.
 */

export interface SendEmailResult {
  ok: boolean;
  reason?: string;
}

const FROM_ADDRESS = "statshelpr <license@statshelpr.com>";

export async function sendResetEmail(
  apiKey: string,
  toEmail: string,
  resetUrl: string,
): Promise<SendEmailResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [toEmail],
        subject: "Reset your statshelpr device activation",
        html: renderResetEmailHtml(resetUrl),
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return {
        ok: false,
        reason: `Resend API ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `Resend request failed: ${(e as Error).message}` };
  }
}

function renderResetEmailHtml(resetUrl: string): string {
  return `
    <p>Someone requested to move your statshelpr license to a new device.</p>
    <p>This will deactivate the device currently using your license so you can
    activate it on a new one. If you didn't request this, you can ignore this
    email — your license won't change.</p>
    <p><a href="${resetUrl}">Reset my device activation</a></p>
    <p>This link expires in 30 minutes and can only be used once.</p>
  `.trim();
}
