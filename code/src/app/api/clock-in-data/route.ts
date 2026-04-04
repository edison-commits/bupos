import { NextResponse } from 'next/server';
import { pgReadLocations } from '@/lib/persistence/postgres-store';
import { pgReadEmployees } from '@/lib/persistence/postgres-store';
import { getAdminSession, getRegisterSession } from '@/lib/auth/session';
const ORG_ID = process.env.BUPOS_ORG_ID || '33262270-7100-4b46-b2fb-8b50ad872bbb';

export async function GET() {
  const [adminCtx, registerCtx] = await Promise.all([getAdminSession(), getRegisterSession()]);
  if (!adminCtx && !registerCtx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [locations, employees] = await Promise.all([
    pgReadLocations(),
    pgReadEmployees(ORG_ID),
  ]);
  return NextResponse.json({ locations, employees });
}
