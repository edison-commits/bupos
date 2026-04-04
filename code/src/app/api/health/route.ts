import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export async function GET() {
  try {
    // Verify DB connectivity
    const { rows } = await pool.query("SELECT 1 AS check");
    if (rows[0]?.check !== 1) {
      return NextResponse.json({ status: "degraded", error: "Database check failed" }, { status: 503 });
    }
    return NextResponse.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      database: "connected",
    });
  } catch (err) {
    console.error("[health] DB check failed:", err);
    return NextResponse.json({ status: "unhealthy", error: "Database unreachable" }, { status: 503 });
  }
}

export async function HEAD() {
  try {
    await pool.query("SELECT 1");
    return new NextResponse(null, { status: 200 });
  } catch {
    return new NextResponse(null, { status: 503 });
  }
}
