import { NextRequest, NextResponse } from "next/server";
import { safeErr } from "@/lib/logging/safe-err";
import { signInAdmin, getAdminSession } from "@/lib/auth/session";
import {
  ensurePreviewAdmin,
  getPreviewConfig,
  previewSecretMatches,
} from "@/lib/preview/admin-preview";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store, private, max-age=0");
  return response;
}

function unavailable(): NextResponse {
  return noStore(new NextResponse("Not found", { status: 404 }));
}

function accessPage(error = false): NextResponse {
  const message = error
    ? '<p style="color:#b91c1c;margin:0 0 16px">That preview code is not valid.</p>'
    : "";
  return noStore(
    new NextResponse(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private Preview</title></head><body style="font-family:system-ui,sans-serif;background:#f4f7f7;min-height:100vh;display:grid;place-items:center;margin:0;padding:16px"><main style="width:min(100%,420px);background:white;border:1px solid #d8e1e1;border-radius:16px;padding:28px;box-shadow:0 8px 30px #1232"><h1 style="margin:0 0 8px;color:#123">Private preview</h1><p style="color:#526060;margin:0 0 24px">Enter the preview access code to continue to the admin panel.</p>${message}<form method="post"><label for="code" style="display:block;font-weight:600;color:#234;margin-bottom:8px">Preview code</label><input id="code" name="code" type="password" required autocomplete="off" style="box-sizing:border-box;width:100%;padding:12px;border:1px solid #b8c6c6;border-radius:10px;margin-bottom:16px"><button type="submit" style="width:100%;padding:12px;border:0;border-radius:10px;background:#0f766e;color:white;font-weight:700;cursor:pointer">Open admin preview</button></form></main></body></html>`,
      { status: error ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
    ),
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!getPreviewConfig()) return unavailable();
  if (await getAdminSession()) {
    return NextResponse.redirect(new URL("/admin", request.url), 303);
  }
  return accessPage();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = getPreviewConfig();
  if (!config) return unavailable();

  const form = await request.formData();
  const candidate = String(form.get("code") ?? "");
  if (!candidate || !(await previewSecretMatches(candidate, config.secret))) {
    return accessPage(true);
  }

  let stage = "provision";
  try {
    await ensurePreviewAdmin(config);
    stage = "sign-in";
    await signInAdmin(config.email, config.password);
  } catch (error) {
    console.error(JSON.stringify({ event: "private_preview_bootstrap_failed", stage, error: safeErr(error) }));
    // Do not reveal whether provisioning, auth, or configuration failed.
    const response = unavailable();
    response.headers.set("x-preview-failure-stage", stage);
    return response;
  }

  return NextResponse.redirect(new URL("/admin", request.url), 303);
}
