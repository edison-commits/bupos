import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

export function middleware(request: NextRequest) {
  const isApiRoute = request.nextUrl.pathname.startsWith('/api/')

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 204 })
    const origin = request.headers.get('origin') ?? '';
    const allowedOrigins = [
      'https://bupos.basicuniform.com',
      ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
    ];
    if (allowedOrigins.includes(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin);
    }
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.set('Access-Control-Max-Age', '3600');
    return response;
  }

  // Pass nonce to the app via a custom request header so Next.js can read it
  const requestHeaders = new Headers(request.headers)
  if (!isApiRoute) {
    const nonce = generateNonce()
    requestHeaders.set('x-nonce', nonce)
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  })

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

  // CSP only for page routes — API routes return JSON and don't need nonce-based CSP
  if (!isApiRoute) {
    const nonce = requestHeaders.get('x-nonce') ?? ''
    response.headers.set(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://*.supabase.co https://*.cloudflare.com; frame-ancestors 'none';`
    )
  }

  // HSTS — force HTTPS (1 year, include subdomains)
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

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
