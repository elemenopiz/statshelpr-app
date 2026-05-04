import { NextRequest, NextResponse } from "next/server";
import { validateLicense } from "@/lib/license";

export const runtime = "nodejs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  let body: { licenseKey?: string };
  try {
    body = (await req.json()) as { licenseKey?: string };
  } catch {
    return NextResponse.json({ ok: false, reason: "Invalid JSON" }, { status: 400, headers: CORS_HEADERS });
  }

  const result = await validateLicense(body.licenseKey ?? "");
  return NextResponse.json(result, {
    status: result.ok ? 200 : 401,
    headers: CORS_HEADERS,
  });
}
