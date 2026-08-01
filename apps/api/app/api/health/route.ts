import { NextResponse } from "next/server";

export const runtime = "nodejs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Lightweight health probe used by the extension popup to render a status dot.
 * No external calls — just confirms the API can answer and surfaces which
 * subsystems are configured.
 */
export function GET() {
  return NextResponse.json(
    {
      ok: true,
      version: "0.2.0",
      provider: "openai",
      openaiConfigured: Boolean(process.env["OPENAI_API_KEY"]),
      // Back-compat alias — shipped extension popups light "AI tutor ready"
      // off this field; mirrors the ACTIVE provider key (see the workers
      // health route for the same pattern).
      geminiConfigured: Boolean(process.env["OPENAI_API_KEY"]),
      sandboxConfigured: Boolean(process.env["R_SANDBOX_SNAPSHOT_ID"]),
      lemonsqueezyConfigured: Boolean(process.env["LEMONSQUEEZY_API_KEY"]),
      time: new Date().toISOString(),
    },
    { status: 200, headers: CORS_HEADERS },
  );
}
