import { NextResponse } from 'next/server';
import { pgReadLocations, pgReadEmployees } from '@/lib/persistence/postgres-store';
import { withDualAuth } from '@/lib/api/with-auth';

export const GET = withDualAuth("register.open", async (_req, ctx) => {
  const { orgId } = ctx;

  const [locations, employees] = await Promise.all([
    pgReadLocations(orgId),
    pgReadEmployees(orgId),
  ]);
  const safeEmployees = employees.map(({ pinHint: _pinHint, ...employee }) => employee);
  return NextResponse.json({ locations, employees: safeEmployees });
});
