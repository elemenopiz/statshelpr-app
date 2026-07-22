/**
 * Constant-time-ish string compare — avoids leaking METRICS_TOKEN
 * length/content via response-time side channels on a naive `===`. Same
 * approach as routes/lemonsqueezy-webhook.ts's private `timingSafeEqual`
 * (duplicated here, not imported, to avoid touching that already-working
 * route for an unrelated feature).
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
