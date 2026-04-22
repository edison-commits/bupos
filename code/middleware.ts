import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64')
}

// R38-C-C1: resolve the Supabase project URL for `connect-src`. Prior
// shape fell through to `https://*.supabase.co` if the env var was
// missing, which on a mis-provisioned prod deploy silently widened CSP
// to ALL supabase projects — a post-XSS data exfiltration bypass. Now
// throws at module load time in production when the var is missing so
// a broken deploy fails loud instead of shipping a permissive CSP.
function resolveSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "")
    || process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  if (url) return url;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL must be set in production — ' +
      'refusing to fall back to wildcard supabase.co which would widen CSP ' +
      'connect-src to every Supabase project.',
    );
  }
  return 'https://*.supabase.co';
}

const SUPABASE_URL_FOR_CSP = resolveSupabaseUrl();

export function middleware(request: NextRequest) {
  const nonce = generateNonce()

  // R38-C-C2: direct-to-origin refusal is handled at the platform
  // layer by `workers_dev: false` in wrangler.jsonc. That disables the
  // `*.workers.dev` bypass so all traffic must flow through the custom
  // domain + CF's WAF / edge rate-limits. A middleware `cf-connecting-
  // ip` header check was evaluated and rejected because Next.js App
  // Router internal RSC subrequests don't always carry the header in
  // the OpenNext routing shim — false-rejecting them would break
  // admin page hydration. Platform-level disable is authoritative.

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 204 })
    const origin = request.headers.get('origin') ?? '';
    const allowedOrigins = [
      'https://bupos.basicuniform.com',
      ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
    ];
    // R27-L6: couple ACAC to ACAO on preflight too.
    // R38-C-M11: ALSO only emit Methods / Headers / Max-Age when the
    // origin is allowed. Prior shape emitted them unconditionally — a
    // minor recon leak that let attackers discover accepted methods
    // without any browser actually honoring the CORS allowance.
    if (allowedOrigins.includes(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Credentials', 'true');
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      response.headers.set('Access-Control-Max-Age', '3600');
    }
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
  //
  // R38-C-H3: added `object-src 'none'`, `frame-src 'none'`,
  // `worker-src 'self'`, `manifest-src 'self'`, and
  // `upgrade-insecure-requests`. Each closes a specific class of
  // post-XSS amplification (object embed, iframe injection, SW origin
  // takeover, HTTP sub-resource downgrade).
  response.headers.set(
    'Content-Security-Policy',
    [
      `default-src 'self'`,
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
      `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data: blob: https://images.unsplash.com https://picsum.photos https://plus.unsplash.com`,
      `font-src 'self' data:`,
      `connect-src 'self' ${SUPABASE_URL_FOR_CSP} https://api.open-meteo.com`,
      `object-src 'none'`,
      `frame-src 'none'`,
      `worker-src 'self'`,
      `manifest-src 'self'`,
      `frame-ancestors 'none'`,
      `base-uri 'self'`,
      `form-action 'self'`,
      `upgrade-insecure-requests`,
    ].join('; ') + ';',
  )

  // HSTS — force HTTPS (2 years, include subdomains, preload-ready).
  // R38-C-H4: extended max-age to 2 years and added `preload` so the
  // domain is eligible for hstspreload.org submission.
  if (request.nextUrl.protocol === "https:") {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
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
    // Apply to all routes except static files and Next.js internals.
    // R38-C-M14: also exclude `sw.js` — every SW request was burning
    // Worker CPU generating a nonce + CSP header + HSTS that just get
    // stapled onto a static JS file.
    '/((?!_next/static|_next/image|favicon.ico|icon-|manifest.json|sitemap.xml|robots.txt|sw\\.js).*)',
  ],
}
