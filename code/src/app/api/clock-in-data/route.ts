import { NextResponse } from 'next/server';
import { pgReadLocations } from '@/lib/persistence/postgres-store';
import { pgReadEmployees } from '@/lib/persistence/postgres-store';
import { getAdminSession, getRegisterSession } from '@/lib/auth/session';

export async function GET() {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  const orgId = adminCtx?.employee?.organizationId ?? registerCtx?.employee?.organizationId;
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }  if (!adminCtx && !registerCtx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [locations, employees] = await Promise.all([
    pgReadLocations(),
    pgReadEmployees(orgId),
  ]);
  return NextResponse.json({ locations, employees });
}
