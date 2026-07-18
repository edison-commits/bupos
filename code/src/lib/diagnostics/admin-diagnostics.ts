export type DiagnosticStatus = "ok" | "warning" | "critical";
export type DiagnosticCategory = "database" | "register" | "inventory" | "payments" | "system";

export interface DiagnosticsContext {
  orgId: string;
  locationId?: string;
  allowedLocations: string[] | null;
  employee: {
    id: string;
    roleKey: string;
    locationIds?: string[];
  };
  reqId: string;
}

export interface DiagnosticCheckResult {
  id: string;
  label: string;
  category: DiagnosticCategory;
  status: DiagnosticStatus;
  summary: string;
  recommendedAction?: string;
  details?: Record<string, unknown>;
}

export interface AdminDiagnosticsResult {
  status: DiagnosticStatus;
  checkedAt: string;
  reqId: string;
  orgId: string;
  locationId?: string;
  roleKey: string;
  checks: DiagnosticCheckResult[];
}

export interface SupportPacketOperatorSummary {
  status: DiagnosticStatus;
  headline: string;
  requestId: string;
  checkedAt: string;
  criticalCount: number;
  warningCount: number;
  okCount: number;
  safeNextSteps: string[];
  safetyNote: string;
}

type QueryResult = { rows: Array<Record<string, unknown>> };
export type DiagnosticsQuery = (sql: string, values?: unknown[]) => Promise<QueryResult>;

const LOCATION_SCOPED_ROLES = ["cashier", "inventory_clerk", "support"] as const;

function roleListIncludes(roles: readonly string[], roleKey: string): boolean {
  return roles.includes(roleKey);
}

function locationFilter(ctx: DiagnosticsContext): { sql: string; values: unknown[] } {
  const scoped = ctx.allowedLocations ?? (roleListIncludes(LOCATION_SCOPED_ROLES, ctx.employee.roleKey) ? ctx.employee.locationIds ?? [] : null);
  if (scoped !== null) {
    return { sql: "AND location_id = ANY($2::uuid[])", values: [ctx.orgId, scoped] };
  }
  if (ctx.locationId) {
    return { sql: "AND location_id = $2", values: [ctx.orgId, ctx.locationId] };
  }
  return { sql: "", values: [ctx.orgId] };
}

function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function openShiftEvidenceCard(row: Record<string, unknown>) {
  return {
    shiftId: String(row.id ?? "unknown"),
    employeeId: String(row.employee_id ?? "unknown"),
    locationId: String(row.location_id ?? "unknown"),
    registerSessionId: typeof row.register_session_id === "string" ? row.register_session_id : null,
    openedAt: String(row.opened_at ?? "unknown"),
    ageHours: toNumber(row.age_hours),
    duplicateOpenShiftCount: toNumber(row.duplicate_count),
    reason: row.reason === "duplicate_open_shift" ? "duplicate_open_shift" : row.reason === "stale_open_shift" ? "stale_open_shift" : "open_shift_review",
  };
}

async function runCheck(
  fallback: DiagnosticCheckResult,
  fn: () => Promise<DiagnosticCheckResult>,
): Promise<DiagnosticCheckResult> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export function summarizeDiagnostics(checks: Array<{ status: DiagnosticStatus }>): DiagnosticStatus {
  if (checks.some((check) => check.status === "critical")) return "critical";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

export async function runAdminDiagnostics(
  ctx: DiagnosticsContext,
  query: DiagnosticsQuery,
): Promise<AdminDiagnosticsResult> {
  const scope = locationFilter(ctx);
  const checks: DiagnosticCheckResult[] = [];

  checks.push(await runCheck(
    {
      id: "database-connectivity",
      label: "Database connectivity",
      category: "database",
      status: "critical",
      summary: "Database connectivity check could not complete.",
      recommendedAction: "Try again. If it stays critical, escalate to technical support before continuing register operations.",
    },
    async () => {
      const result = await query("SELECT 1 AS ok");
      const ok = result.rows[0]?.ok === 1 || result.rows[0]?.ok === "1";
      return ok
        ? {
            id: "database-connectivity",
            label: "Database connectivity",
            category: "database",
            status: "ok",
            summary: "Database is reachable.",
            details: { connected: true },
          }
        : {
            id: "database-connectivity",
            label: "Database connectivity",
            category: "database",
            status: "critical",
            summary: "Database check returned an unexpected result.",
            recommendedAction: "Pause risky register/admin actions and contact support.",
            details: { connected: false },
          };
    },
  ));

  checks.push(await runCheck(
    {
      id: "open-shift-conflicts",
      label: "Open shift conflicts",
      category: "register",
      status: "warning",
      summary: "Open-shift conflict check could not complete.",
      recommendedAction: "Review shift state manually before forcing any close or repair action.",
    },
    async () => {
      const result = await query(
        `SELECT COUNT(*)::int AS conflict_count
         FROM (
           SELECT employee_id, location_id, COUNT(*)::int AS open_count
           FROM shifts
           WHERE organization_id = $1 ${scope.sql} AND status = 'open'
           GROUP BY employee_id, location_id
           HAVING COUNT(*) > 1
         ) conflicts`,
        scope.values,
      );
      const evidence = await query(
        `WITH open_shift_evidence AS (
           SELECT
             id,
             employee_id,
             location_id,
             register_session_id,
             opened_at,
             COUNT(*) OVER (PARTITION BY employee_id, location_id)::int AS duplicate_count,
             ROUND((EXTRACT(EPOCH FROM (NOW() - opened_at)) / 3600.0)::numeric, 1)::float AS age_hours
           FROM shifts
           WHERE organization_id = $1 ${scope.sql} AND status = 'open'
         )
         SELECT
           id,
           employee_id,
           location_id,
           register_session_id,
           opened_at,
           duplicate_count,
           age_hours,
           CASE
             WHEN duplicate_count > 1 THEN 'duplicate_open_shift'
             WHEN opened_at < NOW() - interval '12 hours' THEN 'stale_open_shift'
             ELSE 'open_shift_review'
           END AS reason
         FROM open_shift_evidence
         WHERE duplicate_count > 1 OR opened_at < NOW() - interval '12 hours'
         ORDER BY opened_at ASC
         LIMIT 10`,
        scope.values,
      );
      const conflicts = toNumber(result.rows[0]?.conflict_count);
      const shiftConflictCards = evidence.rows.map(openShiftEvidenceCard);
      const staleOpenShiftCount = shiftConflictCards.filter((card) => card.reason === "stale_open_shift").length;
      const hasShiftRisk = conflicts > 0 || shiftConflictCards.length > 0;
      const summary = hasShiftRisk
        ? `${conflicts} duplicate employee/location conflict${conflicts === 1 ? "" : "s"}; ${staleOpenShiftCount} stale open shift${staleOpenShiftCount === 1 ? "" : "s"} needing review.`
        : "No duplicate or stale open-shift conflicts found.";
      return {
        id: "open-shift-conflicts",
        label: "Open shift conflicts",
        category: "register",
        status: hasShiftRisk ? "warning" : "ok",
        summary,
        recommendedAction: hasShiftRisk ? "Review the shift evidence cards, then create a manager approval request before any close/repair action." : undefined,
        details: { conflictCount: conflicts, staleOpenShiftCount, shiftConflictCards },
      };
    },
  ));

  checks.push(await runCheck(
    {
      id: "inventory-risk",
      label: "Inventory risk",
      category: "inventory",
      status: "warning",
      summary: "Inventory risk check could not complete.",
      recommendedAction: "Use inventory reports before making stock changes.",
    },
    async () => {
      const result = await query(
        `SELECT
           COUNT(*) FILTER (WHERE on_hand < 0)::int AS negative_count,
           COUNT(*) FILTER (WHERE on_hand <= reorder_point AND reorder_point > 0)::int AS low_stock_count
         FROM inventory_levels
         WHERE organization_id = $1 ${scope.sql}`,
        scope.values,
      );
      const negative = toNumber(result.rows[0]?.negative_count);
      const low = toNumber(result.rows[0]?.low_stock_count);
      const risky = negative > 0 || low > 0;
      return {
        id: "inventory-risk",
        label: "Inventory risk",
        category: "inventory",
        status: negative > 0 ? "warning" : low > 0 ? "warning" : "ok",
        summary: risky ? `${negative} negative-stock row${negative === 1 ? "" : "s"}; ${low} low-stock row${low === 1 ? "" : "s"}.` : "No negative or low-stock inventory rows found.",
        recommendedAction: risky ? "Open inventory review before changing quantities." : undefined,
        details: { negativeCount: negative, lowStockCount: low },
      };
    },
  ));

  checks.push(await runCheck(
    {
      id: "recent-transaction-exceptions",
      label: "Recent transaction exceptions",
      category: "payments",
      status: "warning",
      summary: "Recent transaction exception check could not complete.",
      recommendedAction: "Review transactions before retrying tender/refund workflows.",
    },
    async () => {
      const result = await query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'voided')::int AS void_count,
           COUNT(*) FILTER (WHERE status = 'completed' AND grand_total < 0)::int AS refund_count
         FROM transactions
         WHERE organization_id = $1 ${scope.sql} AND created_at > now() - interval '24 hours'`,
        scope.values,
      );
      const voids = toNumber(result.rows[0]?.void_count);
      const refunds = toNumber(result.rows[0]?.refund_count);
      const exceptions = voids + refunds;
      return {
        id: "recent-transaction-exceptions",
        label: "Recent transaction exceptions",
        category: "payments",
        status: exceptions > 0 ? "warning" : "ok",
        summary: exceptions > 0 ? `${voids} voided and ${refunds} refund transaction${refunds === 1 ? "" : "s"} in the last 24 hours.` : "No recent void/refund exception volume found.",
        recommendedAction: exceptions > 0 ? "Review recent transactions before taking payment or refund fixes." : undefined,
        details: { voidCount: voids, refundCount: refunds },
      };
    },
  ));

  return {
    status: summarizeDiagnostics(checks),
    checkedAt: new Date().toISOString(),
    reqId: ctx.reqId,
    orgId: ctx.orgId,
    locationId: ctx.locationId,
    roleKey: ctx.employee.roleKey,
    checks,
  };
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, sanitize(nested)]));
  }
  if (typeof value !== "string") return value;
  if (/\/Users\/|~\/.hermes|file:\/\//.test(value)) return "[redacted]";
  const keyMarker = "sk" + "-";
  const secretMarkers = [keyMarker, "sb" + "_secret_", "OPENAI" + "_API_KEY", "ANTHROPIC" + "_API_KEY", "OPENROUTER" + "_API_KEY", "TELEGRAM" + "_BOT_TOKEN", "CLOUDFLARE" + "_API_TOKEN"];
  if (secretMarkers.some((marker) => value.includes(marker))) return "[redacted]";
  return value;
}

function buildOperatorSummary(diagnostics: AdminDiagnosticsResult): SupportPacketOperatorSummary {
  const criticalCount = diagnostics.checks.filter((check) => check.status === "critical").length;
  const warningCount = diagnostics.checks.filter((check) => check.status === "warning").length;
  const okCount = diagnostics.checks.filter((check) => check.status === "ok").length;
  const headline = diagnostics.status === "critical"
    ? "Store health is critical. Escalate before risky register/admin actions."
    : diagnostics.status === "warning"
      ? "Store health needs manager review."
      : "Store health checks are OK.";
  const safeNextSteps = diagnostics.checks
    .filter((check) => check.status !== "ok" && check.recommendedAction)
    .map((check) => check.recommendedAction as string);

  return {
    status: diagnostics.status,
    headline,
    requestId: diagnostics.reqId,
    checkedAt: diagnostics.checkedAt,
    criticalCount,
    warningCount,
    okCount,
    safeNextSteps,
    safetyNote: "Read-only diagnostics packet. No fix action was performed.",
  };
}

export function buildSupportPacket(diagnostics: AdminDiagnosticsResult) {
  return {
    kind: "bupos-admin-support-packet",
    generatedAt: new Date().toISOString(),
    operatorSummary: buildOperatorSummary(diagnostics),
    diagnostics: sanitize(diagnostics) as AdminDiagnosticsResult,
    nextSteps: diagnostics.checks
      .filter((check) => check.status !== "ok" && check.recommendedAction)
      .map((check) => ({ checkId: check.id, action: check.recommendedAction })),
    note: "Read-only diagnostics packet. No fix action was performed.",
  };
}
