'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { RoleKey } from '@/lib/domain/types';

interface RoleGateProps {
  allowedRoles: RoleKey[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * RoleGate: A client-side access control wrapper component.
 *
 * Reads the user's role from localStorage and checks if it's in the allowedRoles.
 * If the user doesn't have access, displays an access denied message.
 * If no role is stored, displays a sign-in prompt.
 *
 * NOTE: This is purely a UI convenience layer. Server-side authorization
 * is enforced by requireAdminPermission() in API routes. The localStorage
 * role can be manipulated by the client and must never be trusted for
 * security decisions. This component is for UI show/hide only.
 *
 * The role is expected to be written to localStorage under the key
 * 'bupos_employee_role' by the login flow (check auth actions).
 */
export function RoleGate({ allowedRoles, children, fallback }: RoleGateProps) {
  const [mounted, setMounted] = useState(false);
  const [role, setRole] = useState<RoleKey | null>(null);
  const [hasAccess, setHasAccess] = useState(false);

  useEffect(() => {
    // Only run client-side to avoid hydration issues
    setMounted(true);
    const storedRole = localStorage.getItem('bupos_employee_role') as RoleKey | null;
    setRole(storedRole);

    if (storedRole && allowedRoles.includes(storedRole)) {
      setHasAccess(true);
    }
  }, [allowedRoles]);

  // During hydration, don't render anything
  if (!mounted) {
    return null;
  }

  if (!role) {
    return fallback ? (
      <>{fallback}</>
    ) : (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Sign In Required</h1>
            <p className="text-slate-600 mb-4">
              You need to sign in to access this page. Please log in from the register or main menu.
            </p>
            <Link
              href="/"
              className="inline-block px-6 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
            >
              Go to Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!hasAccess) {
    return fallback ? (
      <>{fallback}</>
    ) : (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full">
          <div className="text-center">
            <div className="mb-4 text-5xl">🔒</div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Access Denied</h1>
            <p className="text-slate-600 mb-4">
              Your role ({role}) does not have permission to access this page. Contact an administrator if you believe this is an error.
            </p>
            <a
              href="/admin"
              className="inline-block px-6 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
            >
              Back to Admin
            </a>
          </div>
        </div>
      </div>
    );
  }

  // User has access, render children
  return <>{children}</>;
}
