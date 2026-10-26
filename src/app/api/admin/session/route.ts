import { z } from "zod";
import { errorResponse, readBoundedJson } from "../../_lib/http";
import { guardHostedRequest, hostedRuntime, parseSessionCookie, SESSION_COOKIE } from "@/hosting/guard";

const LoginBody = z.strictObject({ password: z.string().min(1).max(1024) });
const unavailable = () => Response.json({ error: "HOSTED_UNAVAILABLE" }, { status: 503 });
const cookie = (token: string, age: number) => `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;

export function GET(request: Request): Response {
  try {
    const { config, store } = hostedRuntime();
    const authenticated = config.hosted ? store!.isSessionValid(parseSessionCookie(request.headers.get("cookie")), config.adminPassword) : true;
    return Response.json({ hosted: config.hosted, configured: true, authenticated, canReview: authenticated }, { headers: { "Cache-Control": "no-store" } });
  } catch { return unavailable(); }
}

export async function POST(request: Request): Promise<Response> {
  let runtime: ReturnType<typeof hostedRuntime>;
  try { runtime = hostedRuntime(); } catch { return unavailable(); }
  try {
    const { config, store } = runtime;
    if (!config.hosted || !store) return Response.json({ error: "HOSTED_ONLY" }, { status: 404 });
    const guard = guardHostedRequest(request, { limit: "login" }, config, store);
    if (guard) return guard;
    const { password } = LoginBody.parse(await readBoundedJson(request));
    if (!store.verifyPassword(password, config.adminPassword)) return Response.json({ error: "INVALID_CREDENTIALS" }, { status: 401 });
    const token = store.createSession(config.adminPassword);
    return Response.json({ hosted: true, configured: true, authenticated: true, canReview: true }, { headers: { "Set-Cookie": cookie(token, 2 * 60 * 60), "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export function DELETE(request: Request): Response {
  try {
    const { config, store } = hostedRuntime();
    if (!config.hosted || !store) return Response.json({ error: "HOSTED_ONLY" }, { status: 404 });
    const guard = guardHostedRequest(request, {}, config, store);
    if (guard) return guard;
    store.revokeSession(parseSessionCookie(request.headers.get("cookie")));
    return Response.json({ hosted: true, configured: true, authenticated: false, canReview: false }, { headers: { "Set-Cookie": cookie("", 0), "Cache-Control": "no-store" } });
  } catch { return unavailable(); }
}
