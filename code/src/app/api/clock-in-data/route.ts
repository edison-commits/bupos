import { NextResponse } from 'next/server';
import { pgReadLocations, pgReadEmployees } from '@/lib/persistence/postgres-store';
import { withDualAuth } from '@/lib/api/with-auth';

export const GET = withDualAuth("register.open", async (_req, ctx) => {
  const { orgId } = ctx;

  const [locations, employees] = await Promise.all([
    pgReadLocations(orgId),
    pgReadEmployees(orgId),
  ]);
  // Strip pin_hint AND contact fields (email/phone). The clock-in UI only
  // needs the employee picker — leaking emails to every register.open holder
  // enables phishing against managers (password-reset lure delivered from a
  // familiar domain to a real address). Any caller that legitimately needs
  // email/phone should go through /api/employees where the gate is
  // employee.manage.
  const safeEmployees = employees.map(({
    pinHint: _pinHint,
    email: _email,
    ...employee
  }) => employee);
  return NextResponse.json({ locations, employees: safeEmployees });
});
