import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const response = NextResponse.next()

  // CORS — allow same-origin and known cross-origin API callers
  const origin = request.headers.get('origin') ?? '';
  const allowedOrigins = [
    'https://bupos.basicuniform.com',
    ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
  ];
  const isCorsAllowed =
    origin === '' || // same-origin
    allowedOrigins.some((o) => origin === o);
  if (isCorsAllowed) {
    response.headers.set('Access-Control-Allow-Origin', origin || "'self'");
  }
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Max-Age', '3600');

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff')

  // Prevent clickjacking
  response.headers.set('X-Frame-Options', 'DENY')

  // XSS protection
  response.headers.set('X-XSS-Protection', '1; mode=block')

  // Content Security Policy — restrict to same-origin, no eval
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://*.supabase.co https://*.cloudflare.com; frame-ancestors 'none';"
  )

  // Referrer policy
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')

  // Permissions policy (disable features the app doesn't need)
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  )

  return response
}

export const config = {
  matcher: [
    // Apply to all routes except static files and Next.js internals
    '/((?!_next/static|_next/image|favicon.ico|icon-|manifest.json|sitemap.xml|robots.txt).*)',
  ],
}