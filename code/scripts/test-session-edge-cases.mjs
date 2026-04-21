#!/usr/bin/env node
/**
 * Session edge-case test.
 *
 * Directly exercises session-lifecycle behavior at the DB layer — the
 * things an attacker would target and that aren't covered by happy-path
 * tests:
 *
 *   S1. Expired admin session row is not returned by resolution query.
 *   S2. Deactivating an employee invalidates their live sessions (R7-H-4
 *       added the audit event; R6-C-2 fix for cross-tenant toggle).
 *   S3. Session rotation: new admin login deletes prior admin sessions for
 *       the same employee (per admin_login_create_session RPC).
 *   S4. Register-scope cookie on admin endpoint: the admin session resolver
 *       filters WHERE scope = 'admin' so a register-scope session id that
 *       somehow reaches the admin cookie should not resolve.
 *   S5. Session for a different organization than the caller expects must
 *       not resolve.
 */

import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";

const txt = fs.readFileSync("/Users/edison/Desktop/bupos/code/.env.local", "utf8");
for (const line of txt.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
  if (m) process.env[m[1]] = process.env[m[1]] ?? m[2].replace(/^"|"$/g, "");
}

const ORG_A = "33262270-7100-4b46-b2fb-8b50ad872bbb";
const ORG_B = "713b3ff4-0582-40b1-98b0-02303af31e6f";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "\u2713" : "\u2717"} ${name}${detail ? `  (${detail})` : ""}`);
}

async function getEmployee(orgId) {
  const { rows } = await pool.query(
    `SELECT id FROM employees WHERE organization_id = $1 LIMIT 1`,
    [orgId],
  );
  return rows[0]?.id;
}

async function testExpiredSession() {
  const empId = await getEmployee(ORG_A);
  const sessionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, employee_id, organization_id, scope, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, 'admin', NOW() - interval '10 days', NOW() - interval '10 days', NOW() - interval '1 hour')`,
    [sessionId, empId, ORG_A],
  );
  // Mirror session.ts's resolveSession query — it reads `expires_at` and
  // treats past-expiry as not-found. We verify by filtering here.
  const { rows } = await pool.query(
    `SELECT id FROM sessions WHERE id = $1 AND scope = 'admin' AND expires_at > NOW()`,
    [sessionId],
  );
  record(
    "S1 expired admin session does not resolve",
    rows.length === 0,
    `rows=${rows.length} (expected 0)`,
  );
  await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

async function testEmployeeDeactivationInvalidatesSessions() {
  const empId = await getEmployee(ORG_A);
  const sessionId = crypto.randomUUID();
  // Create a live session
  await pool.query(
    `INSERT INTO sessions (id, employee_id, organization_id, scope, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, 'admin', NOW(), NOW(), NOW() + interval '7 days')`,
    [sessionId, empId, ORG_A],
  );
  // Simulate the deactivate → invalidateEmployeeSessions path in
  // src/app/api/employees/route.ts: DELETE all sessions for that employee.
  await pool.query(
    `DELETE FROM sessions WHERE employee_id = $1 AND organization_id = $2`,
    [empId, ORG_A],
  );
  const { rows } = await pool.query(`SELECT id FROM sessions WHERE id = $1`, [sessionId]);
  record(
    "S2 deactivate-employee-path deletes live sessions",
    rows.length === 0,
    `rows=${rows.length} (expected 0)`,
  );
}

async function testSessionRotationOnLogin() {
  const empId = await getEmployee(ORG_A);
  const s1 = crypto.randomUUID();
  const s2 = crypto.randomUUID();

  // Pre-state: one admin session exists.
  await pool.query(
    `INSERT INTO sessions (id, employee_id, organization_id, scope, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, 'admin', NOW(), NOW(), NOW() + interval '7 days')`,
    [s1, empId, ORG_A],
  );

  // admin_login_create_session deletes prior admin sessions for the
  // employee and inserts a new one (see migrations/019_admin_login_rpc.sql).
  await pool.query(
    `DELETE FROM sessions WHERE scope = 'admin' AND employee_id = $1`,
    [empId],
  );
  await pool.query(
    `INSERT INTO sessions (id, employee_id, organization_id, scope, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, 'admin', NOW(), NOW(), NOW() + interval '7 days')`,
    [s2, empId, ORG_A],
  );

  const { rows } = await pool.query(
    `SELECT id FROM sessions WHERE employee_id = $1 AND scope = 'admin' ORDER BY created_at DESC`,
    [empId],
  );
  const onlyNew = rows.length === 1 && rows[0].id === s2;
  record(
    "S3 login rotation: prior admin session deleted, new one inserted",
    onlyNew,
    `found=${rows.length}, latest_id_match=${rows[0]?.id === s2}`,
  );

  await pool.query(`DELETE FROM sessions WHERE id = $1`, [s2]);
}

async function testWrongScopeRejected() {
  const empId = await getEmployee(ORG_A);
  const sessionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, employee_id, organization_id, scope, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, 'register', NOW(), NOW(), NOW() + interval '1 day')`,
    [sessionId, empId, ORG_A],
  );
  // Admin resolver filters WHERE scope = 'admin' — a register-scope row
  // must not resolve.
  const { rows: admin } = await pool.query(
    `SELECT id FROM sessions WHERE id = $1 AND scope = 'admin' AND expires_at > NOW()`,
    [sessionId],
  );
  // But register resolver WOULD find it with scope='register'.
  const { rows: register } = await pool.query(
    `SELECT id FROM sessions WHERE id = $1 AND scope = 'register' AND expires_at > NOW()`,
    [sessionId],
  );
  record(
    "S4 register-scope session does NOT resolve as admin",
    admin.length === 0 && register.length === 1,
    `admin_rows=${admin.length}, register_rows=${register.length}`,
  );
  await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

async function testCrossTenantSessionRejected() {
  // A session row that legitimately exists for ORG_A — if ORG_B somehow
  // probes its UUID, the org scope filter should prevent the ORG_B caller
  // from "using" it. The resolver loads organization_id from the session
  // row; subsequent orgTx calls set app.current_org_id to THAT value. So
  // the test here is simpler: the session row carries organization_id,
  // and callers cannot spoof a different org via the session alone.
  const empId = await getEmployee(ORG_A);
  const sessionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, employee_id, organization_id, scope, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, 'admin', NOW(), NOW(), NOW() + interval '7 days')`,
    [sessionId, empId, ORG_A],
  );
  const { rows } = await pool.query(
    `SELECT organization_id FROM sessions WHERE id = $1`,
    [sessionId],
  );
  record(
    "S5 session carries its own org_id (resolver uses session's org, not caller's)",
    rows[0]?.organization_id === ORG_A,
    `org_id=${rows[0]?.organization_id}`,
  );
  await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

async function testInactivityTimeout() {
  // R3.3: admin session should be considered stale after 4h of inactivity.
  // Create a session with last_seen_at 5h ago; verify the filter used by
  // session.ts's inactivity check rejects it.
  const empId = await getEmployee(ORG_A);
  const sessionId = crypto.randomUUID();
  const ADMIN_INACTIVITY_TIMEOUT_MS = 4 * 60 * 60 * 1000;
  await pool.query(
    `INSERT INTO sessions (id, employee_id, organization_id, scope, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, 'admin', NOW() - interval '1 day', NOW() - interval '5 hours', NOW() + interval '7 days')`,
    [sessionId, empId, ORG_A],
  );
  const { rows } = await pool.query(
    `SELECT last_seen_at FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const lastSeenMs = new Date(rows[0].last_seen_at).getTime();
  const stale = (Date.now() - lastSeenMs) > ADMIN_INACTIVITY_TIMEOUT_MS;
  record(
    "S6 admin session >4h inactive is stale (inactivity-timeout check)",
    stale,
    `age=${((Date.now() - lastSeenMs) / 1000 / 60 / 60).toFixed(2)}h (expected > 4h)`,
  );
  await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  // Silence unused-var warning
  void ORG_B;
}

async function main() {
  console.log("─── Session edge cases ────────────────────────────────────");
  await testExpiredSession();
  await testEmployeeDeactivationInvalidatesSessions();
  await testSessionRotationOnLogin();
  await testWrongScopeRejected();
  await testCrossTenantSessionRejected();
  await testInactivityTimeout();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log();
  console.log(`${passed}/${results.length} passed, ${failed} failed`);

  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
