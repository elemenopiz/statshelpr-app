import { NextRequest, NextResponse } from "next/server";

/**
 * Access gate for /dashboard (internal metrics dashboard — see
 * app/dashboard/page.tsx). Runs before the page renders so an unauthorized
 * request never executes the page component at all, and so we can return a
 * real 401 status (Server Components can't set arbitrary status codes on
 * their own without the experimental `authInterrupts` flag — the proxy layer
 * can, with zero config).
 *
 * Named `proxy.ts` (not `middleware.ts`) per Next 16's renamed convention —
 * see https://nextjs.org/docs/messages/middleware-to-proxy. Same mechanism,
 * new name.
 *
 * Set DASHBOARD_PASSWORD in the environment to enable access. Visit
 * /dashboard?key=<password> once; a short-lived httpOnly cookie is then set
 * so subsequent navigation within /dashboard doesn't need the query param on
 * every link. Fails CLOSED: if DASHBOARD_PASSWORD is unset, nobody gets in
 * (including ?demo=1) — this page must never be world-readable.
 */

const COOKIE_NAME = "sh_dash_key";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function proxy(req: NextRequest): NextResponse {
  const password = process.env["DASHBOARD_PASSWORD"];

  if (!password) {
    return unauthorized(
      "DASHBOARD_PASSWORD is not configured on the server, so /dashboard is fully locked. " +
        "Set it in the environment (Vercel project settings, or apps/api/.env.local for local dev) to enable access.",
    );
  }

  const keyParam = req.nextUrl.searchParams.get("key");
  const cookieVal = req.cookies.get(COOKIE_NAME)?.value;
  const authorized = keyParam === password || cookieVal === password;

  if (!authorized) {
    return unauthorized("Missing or invalid access key. Append ?key=<DASHBOARD_PASSWORD> to the URL.");
  }

  const res = NextResponse.next();

  // Persist the cookie once so links within the dashboard don't all need
  // ?key= appended. Only set it when it isn't already correctly set, to
  // avoid rewriting the response header on every single request.
  if (keyParam === password && cookieVal !== password) {
    res.cookies.set(COOKIE_NAME, password, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: COOKIE_MAX_AGE_SECONDS,
      path: "/dashboard",
    });
  }

  return res;
}

function unauthorized(reason: string): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="robots" content="noindex, nofollow" />
<title>401 — Unauthorized</title>
<style>
  body { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; background: #131310; color: #f2f0e8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
  main { max-width: 30rem; }
  h1 { font-size: 1.1rem; margin: 0 0 0.75rem; }
  p { color: #c8c4b6; font-size: 0.9rem; line-height: 1.5; }
  code { background: rgba(242,240,232,0.1); border-radius: 4px; padding: 0.1rem 0.35rem; }
</style>
</head>
<body>
<main>
<h1>401 — Unauthorized</h1>
<p>${escapeHtml(reason)}</p>
</main>
</body>
</html>`;

  return new NextResponse(html, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const config = {
  matcher: ["/dashboard", "/dashboard/:path*"],
};
