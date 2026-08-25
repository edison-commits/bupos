/**
 * Auth-aware fetch for client-side admin/Register UI.
 * Automatically redirects to /admin when the session expires (401).
 * Use this instead of raw fetch() for all /api/* calls in client components.
 */
export async function authFetch(
  input: RequestInfo | URL,
  options?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, {
    credentials: 'include', // send session cookie to /api/*
    ...options,
  });

  if (response.status === 401) {
    // Session expired — redirect to admin login
    window.location.href = new URL('/admin', window.location.origin).toString();
    throw new Error('Session expired');
  }

  return response;
}
