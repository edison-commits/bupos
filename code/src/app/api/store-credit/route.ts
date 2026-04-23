import { NextResponse } from "next/server";
import { orgQuery, orgTx } from "@/lib/supabase-rest";
import { randomUUID } from "@/lib/uuid";
import { withAdminAuth } from "@/lib/api/with-auth";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { pgInsertAuditEvent } from "@/lib/persistence/postgres-store";
import { validateBody, storeCreditSchema } from "@/lib/validation/schemas";
import { formatCurrency } from "@/lib/format";


import { safeErr } from "@/lib/logging/safe-err";
import { waitUntilOrAwait } from "@/lib/runtime/wait-until";
/**
 * GET /api/store-credit
 *
 * Query params:
 *   customer — customer ID (returns balance + ledger for that customer)
 *   page     — page number (default 1)
 *   limit    — results per page (default 50)
 *
 * Without customer param returns all customers with credit + summary.
 */
export const GET = withAdminAuth("audit.view", async (req, ctx) => {
  const { orgId } = ctx;

  try {
    const sp = req.nextUrl.searchParams;
    const customerId = sp.get("customer");

    if (customerId) {
      // Single customer balance + ledger
      const customer = await orgQuery(
        orgId,
        `SELECT id, first_name, last_name, email, phone, store_credit_balance
         FROM customers WHERE id = $1 AND organization_id = $2`,
        [customerId, orgId],
      );
      if (customer.rows.length === 0) {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      }

      // Paginated ledger — previously unbounded, a customer with thousands of
      // entries would pull everything. Default page 100, cap 500.
      const page = Math.max(1, Number(sp.get("page")) || 1);
      const limit = Math.min(500, Math.max(1, Number(sp.get("limit")) || 100));
      const offset = (page - 1) * limit;
      // R28-L5: employees LEFT JOIN gated by org too (defense in depth).
      const ledger = await orgQuery(
        orgId,
        `SELECT scl.*, e.display_name AS employee_name
         FROM store_credit_ledger scl
         LEFT JOIN employees e ON e.id = scl.employee_id AND e.organization_id = $2
         WHERE scl.organization_id = $2 AND scl.customer_id = $1
         ORDER BY scl.created_at DESC, scl.id DESC
         LIMIT $3 OFFSET $4`,
        [customerId, orgId, limit, offset],
      );

      return NextResponse.json({
        customer: customer.rows[0],
        ledger: ledger.rows,
      });
    }

    // All customers with store credit — paginate via (balance, id) cursor.
    // Hardcoded LIMIT 500 silently dropped rows past the 501st. Cursor is
    // base64({ balance: string, id: string }); balance is a string so we
    // don't lose precision on numeric(12,2).
    const pageSize = Math.min(500, Math.max(10, Number(sp.get("pageSize")) || 200));
    const cursorParam = sp.get("cursor");
    let cursorBal: string | null = null;
    let cursorId: string | null = null;
    if (cursorParam) {
      try {
        const decoded = JSON.parse(Buffer.from(cursorParam, "base64").toString("utf-8"));
        if (typeof decoded.balance === "string" && /^\d+(\.\d+)?$/.test(decoded.balance)) cursorBal = decoded.balance;
        if (typeof decoded.id === "string") cursorId = decoded.id;
      } catch {
        /* invalid cursor — reset to page 1 */
      }
    }
    // R27-C5: orgId is now $1; cursor params shift to $2/$3. Without
    // the `organization_id = $1` predicate, this endpoint listed every
    // tenant's customers holding store credit (name+email+phone+balance).
    const cursorWhere = (cursorBal && cursorId)
      ? ` AND (store_credit_balance, id) < ($2::numeric, $3::uuid)`
      : "";
    const cursorParams: unknown[] = cursorBal && cursorId ? [cursorBal, cursorId] : [];
    const customers = await orgQuery(
      orgId,
      `SELECT id, first_name, last_name, email, phone, store_credit_balance
       FROM customers
       WHERE organization_id = $1 AND store_credit_balance > 0${cursorWhere}
       ORDER BY store_credit_balance DESC, id DESC
       LIMIT $${cursorParams.length + 2}`,
      [orgId, ...cursorParams, pageSize + 1],
    );
    const hasMore = customers.rows.length > pageSize;
    const pageRows = hasMore ? customers.rows.slice(0, pageSize) : customers.rows;
    const nextCursor = hasMore && pageRows.length > 0
      ? Buffer.from(JSON.stringify({
          balance: String(pageRows[pageRows.length - 1].store_credit_balance),
          id: pageRows[pageRows.length - 1].id,
        })).toString("base64")
      : null;

    const summary = await orgQuery(
      orgId,
      `SELECT
         COALESCE(SUM(store_credit_balance), 0)::numeric AS total_outstanding,
         COUNT(*) FILTER (WHERE store_credit_balance > 0)::int AS customers_with_credit,
         COALESCE(SUM(scl.amount) FILTER (WHERE scl.transaction_type = 'issuance'), 0)::numeric AS total_issued,
         COALESCE(SUM(ABS(scl.amount)) FILTER (WHERE scl.transaction_type = 'redemption'), 0)::numeric AS total_redeemed
       FROM customers
       LEFT JOIN store_credit_ledger scl ON scl.customer_id = customers.id AND scl.organization_id = $1
       WHERE customers.organization_id = $1`,
      [orgId],
    );

    // R27-C5: JOINs also constrained by org for defense-in-depth —
    // scl.organization_id is the primary gate but a crafted row
    // with a cross-org employee_id / customer_id would otherwise
    // splice foreign display names into the ledger view.
    const recentLedger = await orgQuery(
      orgId,
      `SELECT scl.*, e.display_name AS employee_name,
              c.first_name || ' ' || c.last_name AS customer_name
       FROM store_credit_ledger scl
       LEFT JOIN employees e ON e.id = scl.employee_id AND e.organization_id = $1
       LEFT JOIN customers c ON c.id = scl.customer_id AND c.organization_id = $1
       WHERE scl.organization_id = $1
       ORDER BY scl.created_at DESC
       LIMIT 50`,
      [orgId],
    );

    return NextResponse.json({
      customers: pageRows,
      nextCursor,
      hasMore,
      summary: summary.rows[0],
      recentLedger: recentLedger.rows,
    });
  } catch (err) {
    console.error("GET /api/store-credit error:", safeErr(err));
    return NextResponse.json({ error: "Failed to fetch store credit" }, { status: 500 });
  }
});

/**
 * POST /api/store-credit
 *
 * Body: { customerId, amount, reason, employeeId, approvedBy? }
 *
 * Issues store credit to a customer. Amount must be positive.
 */
export const POST = withAdminAuth('approval.store_credit', async (req, ctx) => {
  const { orgId, employee } = ctx;
  const employeeId = employee.id;

  const rl = checkRateLimit(`store-credit:${employeeId}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  try {
    const body = await req.json();
    const v = validateBody(storeCreditSchema, body);
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 });
    const { customerId, amount, reason } = v.data;

    // R32-H10: step-up auth. Store credit is cash-equivalent at
    // checkout redemption. A stolen manager cookie without this gate
    // could mint up to MAX_DAILY_STORE_CREDIT_PER_ACTOR daily (even
    // with R31-H4's caps). Same pattern the employees PATCH
    // (R28-H4) enforces for PIN reset / activate / deactivate.
    const { requireStepUp } = await import('@/lib/auth/step-up');
    const stepUp = await requireStepUp({
      actorId: employeeId,
      orgId,
      actorPassword: (body as { actorPassword?: string }).actorPassword,
      bucketKey: 'store-credit-stepup',
    });
    if (!stepUp.ok) {
      return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
    }
    // approvedBy is always the authenticated admin — never trust the body.
    // This prevents attributing an issuance to a different employee.
    const approvedBy = ctx.employee.id;

    // R30-H4: hard per-request + rolling 24h per-actor caps. The schema
    // allows up to $10M per call; without these caps a compromised
    // manager session could mint arbitrary store-credit (cash-equivalent
    // at checkout) and redeem it. Gift-cards have the same shape
    // (R28-M8 / R29-M2 — $5K/request, $25K/24h); store-credit was the
    // loud outlier. The admin server-action mirror (admin/store-credit-
    // actions.ts) enforces $10K/request in-process, but that doesn't
    // bind public-API callers — the cap MUST live on the route.
    const MAX_STORE_CREDIT_PER_REQUEST = 5_000;
    const MAX_DAILY_STORE_CREDIT_PER_ACTOR = 25_000;
    if (amount > MAX_STORE_CREDIT_PER_REQUEST) {
      return NextResponse.json(
        { error: `Store credit issuance exceeds per-request cap of ${formatCurrency(MAX_STORE_CREDIT_PER_REQUEST)}. Split into multiple entries or escalate.` },
        { status: 400 },
      );
    }

    const client = await orgTx(orgId);
    try {
      // R31-M4: the 24h cap check runs INSIDE the orgTx so two
      // concurrent issuances can't both pass the cap (both see
      // minted=X, both pass X+amount, both commit X+2*amount > MAX).
      // Inside-tx reads under READ COMMITTED still see only committed
      // rows, so this is NOT serializable — but combined with a
      // transaction-scoped advisory lock keyed on the actor, we
      // serialize issuances for the same actor. Different actors
      // still run in parallel.
      await client.query(
        `SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64)::bigint))`,
        [`store-credit-actor:${orgId}:${employeeId}`],
      );
      const { rows: dailyRows } = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS minted
           FROM store_credit_ledger
          WHERE organization_id = $1
            AND employee_id = $2
            AND transaction_type = 'issuance'
            AND created_at >= now() - interval '24 hours'`,
        [orgId, employeeId],
      );
      const minted24h = Number(dailyRows[0]?.minted ?? 0) || 0;
      if (minted24h + amount > MAX_DAILY_STORE_CREDIT_PER_ACTOR) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: `24-hour store-credit issuance cap of ${formatCurrency(MAX_DAILY_STORE_CREDIT_PER_ACTOR)} exceeded (already ${formatCurrency(minted24h)} in the last 24h).` },
          { status: 429 },
        );
      }
      // Update customer balance. Defence-in-depth: RLS via orgTx blocks
      // cross-org UPDATEs today, but an explicit `organization_id` in
      // the WHERE clause is cheap insurance against future policy
      // regressions (e.g. RLS swapped to advisory USING without CHECK).
      // R75-M: `AND is_active = true`. Anonymized customers (GDPR
      // right-to-be-forgotten DELETE) carry is_active=false and have
      // their balance zeroed; without this filter, a late refund or
      // manual issuance would write credit back onto the [deleted]
      // record. The customer can never redeem (checkout filters
      // is_active), so the balance becomes a permanent invisible
      // liability and an erased PII record is being mutated with
      // financial data post-erasure (GDPR compliance break).
      const updated = await client.query(
        `UPDATE customers SET store_credit_balance = store_credit_balance + $1, updated_at = now()
         WHERE id = $2 AND organization_id = $3 AND is_active = true
         RETURNING store_credit_balance`,
        [amount, customerId, orgId],
      );
      if (updated.rows.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Customer not found or inactive" }, { status: 404 });
      }

      const newBalance = updated.rows[0].store_credit_balance;

      // Insert ledger entry
      const entryId = randomUUID();
      await client.query(
        `INSERT INTO store_credit_ledger (id, organization_id, customer_id, transaction_type, amount, balance_after, employee_id, reason, approved_by, created_at)
         VALUES ($1, $2, $3, 'issuance', $4, $5, $6, $7, $8, now())`,
        [entryId, orgId, customerId, amount, newBalance, employeeId, reason, approvedBy || null],
      );

      // R46-H1: audit INSIDE the transaction. Prior shape used
      // waitUntilOrAwait(pgInsertAuditEvent(...)) AFTER COMMIT; if the
      // audit write failed (isolate freeze, RLS drift, DB hiccup), the
      // ledger row persisted without a standalone audit trail. Matches
      // the R44-MED / R45-M pattern already applied to the server-
      // action sibling.
      await client.query(
        `INSERT INTO audit_events (id, organization_id, location_id, actor_employee_id, entity_type, entity_id, event_kind, payload, created_at)
         VALUES ($1, $2, $3, $4, 'customer', $5, 'store_credit_issued', $6, now())`,
        [
          randomUUID(), orgId, null, employeeId, customerId,
          JSON.stringify({ id: entryId, amount, new_balance: newBalance, reason }),
        ],
      );
      await client.query("COMMIT");
      return NextResponse.json({ id: entryId, customerId, newBalance, amount }, { status: 201 });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("POST /api/store-credit error:", safeErr(err));
    return NextResponse.json({ error: "Failed to issue store credit" }, { status: 500 });
  }
});
