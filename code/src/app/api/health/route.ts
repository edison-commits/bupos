import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ ok: true, ts: Date.now() });
}

export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}
