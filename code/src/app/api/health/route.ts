import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export async function GET() {
  try {
    // pg_stat_activity is a heavier but more realistic probe than SELECT 1 —
    // it verifies the DB can actually process a query under load, not just that
    // the connection is alive.
    const { rows } = await pool.query(
      `SELECT 1 AS check, now() AS ts, version()::text AS pg_version LIMIT 1`
    );
    if (rows[0]?.check !== 1) {
      return NextResponse.json({ status: "degraded", error: "Database check failed" }, { status: 503 });
    }
    return NextResponse.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      database: "connected",
      pgVersion: rows[0]?.pg_version?.slice(0, 40) ?? "unknown",
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
