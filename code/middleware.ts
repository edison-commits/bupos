import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64')
}

export function middleware(request: NextRequest) {
  const nonce = generateNonce()

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 204 })
    const origin = request.headers.get('origin') ?? '';
    const allowedOrigins = [
      'https://bupos.basicuniform.com',
      ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
    ];
    // R27-L6: couple ACAC to ACAO on preflight too.
    if (allowedOrigins.includes(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Credentials', 'true');
    }
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    response.headers.set('Access-Control-Max-Age', '3600');
    return response;
  }

  // Pass nonce to the app via a custom request header so Next.js can read it
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  })

  // CORS — allow same-origin and known cross-origin API callers
  const origin = request.headers.get('origin') ?? '';
  const allowedOrigins = [
    'https://bupos.basicuniform.com',
    ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
  ];
  // For same-origin requests browsers don't send Origin, so we don't need to set ACAO.
  // Only set for allowed cross-origin requests with a real origin string.
  //
  // R27-L6: couple `Access-Control-Allow-Credentials` to ACAO. Browsers
  // ignore ACAC when ACAO isn't set, so emitting it unconditionally is
  // safe today — but leaving the two decoupled is a footgun. A future
  // change that widens ACAO to `*` or echoes every origin would
  // INSTANTLY become a credentialed-CORS leak. Coupling makes that
  // failure mode impossible.
  // R28-L8: every CORS header is only emitted when the origin is in
  // the allowlist. Prior shape set Methods/Headers unconditionally —
  // ignored by browsers without ACAO but still a tiny recon leak
  // (attacker learns which methods the server accepts for the
  // allowlisted origins without triggering an actual preflight).
  const originAllowed = origin && allowedOrigins.some((o) => origin === o);
  if (originAllowed) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    response.headers.set('Access-Control-Max-Age', '3600');
  }

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff')

  // Prevent clickjacking
  response.headers.set('X-Frame-Options', 'DENY')

  // X-XSS-Protection is deprecated and can create vulnerabilities on old browsers; disable.
  response.headers.set('X-XSS-Protection', '0')

  // Content Security Policy — nonce for scripts, but allow 'unsafe-inline' styles
  // (Tailwind injects inline styles for transitions/dynamic classes in dev).
  // Scripts must carry nonce={nonce} or be hashed; see app/layout.tsx for the
  // service-worker registration which reads the nonce via headers().
  // CSP: prefer an exact Supabase project URL over the wildcard so an XSS
  // on our domain can't exfiltrate data to an attacker-controlled Supabase
  // project. SUPABASE_URL is set on Workers; fall back to the wildcard at
  // build time if missing so dev builds still work.
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "")
    || process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "")
    || "https://*.supabase.co";
  response.headers.set(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://images.unsplash.com https://picsum.photos https://plus.unsplash.com; font-src 'self' data:; connect-src 'self' ${supabaseUrl} https://api.open-meteo.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self';`
  )

  // HSTS — force HTTPS (1 year, include subdomains). Trigger on the request
  // scheme rather than NODE_ENV so staging/preview environments served over
  // HTTPS get the header even when NODE_ENV stays at its Next.js default.
  // (Matches the Secure cookie flag logic in session.ts.)
  if (request.nextUrl.protocol === "https:") {
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
