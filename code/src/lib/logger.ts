import { NextRequest, NextResponse } from "next/server";

export interface LogEntry {
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  duration: number;
  status: number;
  error?: string;
}

function emit(entry: LogEntry) {
  const line = JSON.stringify(entry);
  if (entry.error) {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * Wraps an API route handler with structured request logging.
 * Logs request start/end with timing and status.
 */
export function withLogging<T extends unknown[]>(
  handler: (req: NextRequest, ...rest: T) => Promise<NextResponse>,
): (req: NextRequest, ...rest: T) => Promise<NextResponse> {
  return async (req: NextRequest, ...rest: T): Promise<NextResponse> => {
    const requestId = crypto.randomUUID();
    const start = performance.now();
    const method = req.method;
    const path = req.nextUrl.pathname;

    let res: NextResponse;
    try {
      res = await handler(req, ...rest);
    } catch (err) {
      const duration = Math.round(performance.now() - start);
      emit({
        timestamp: new Date().toISOString(),
        requestId,
        method,
        path,
        duration,
        status: 500,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const duration = Math.round(performance.now() - start);
    emit({
      timestamp: new Date().toISOString(),
      requestId,
      method,
      path,
      duration,
      status: res.status,
    });

    // Attach request ID header for traceability
    res.headers.set("x-request-id", requestId);
    return res;
  };
}
