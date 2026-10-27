import { z } from "zod";
import { connection } from "next/server";
import { errorResponse, readBoundedJson, RequestBodyError } from "../../_lib/http";
import { guardHostedRequest, hostedRuntime, invalidHostedOrigin, parseSessionCookie, SESSION_COOKIE } from "@/hosting/guard";
import { hostedConfig } from "@/hosting/config";

const LoginBody = z.strictObject({ password: z.string().min(1).max(1024) });
const unavailable = () => Response.json({ error: "HOSTED_UNAVAILABLE" }, { status: 503 });
const cookie = (token: string, age: number) => `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;

export async function GET(request: Request): Promise<Response> {
  await connection();
  try {
    const { config, store } = await hostedRuntime();
    const authenticated = config.hosted ? await store!.isSessionValid(parseSessionCookie(request.headers.get("cookie")), config.adminPassword) : true;
    return Response.json({ hosted: config.hosted, configured: true, authenticated, canReview: authenticated }, { headers: { "Cache-Control": "no-store" } });
  } catch { return unavailable(); }
}

export async function POST(request: Request): Promise<Response> {
  let config: ReturnType<typeof hostedConfig>;
  try { config = hostedConfig(); } catch { return unavailable(); }
  if (!config.hosted) return Response.json({ error: "HOSTED_ONLY" }, { status: 404 });
  const originError = invalidHostedOrigin(request, config);
  if (originError) return originError;
  try {
    const { store } = await hostedRuntime(config);
    const guard = await guardHostedRequest(request, { limit: "login" }, config, store!);
    if (guard) return guard;
    const { password } = LoginBody.parse(await readBoundedJson(request));
    if (!store!.verifyPassword(password, config.adminPassword)) return Response.json({ error: "INVALID_CREDENTIALS" }, { status: 401 });
    const token = await store!.createSession(config.adminPassword);
    return Response.json({ hosted: true, configured: true, authenticated: true, canReview: true }, { headers: { "Set-Cookie": cookie(token, 2 * 60 * 60), "Cache-Control": "no-store" } });
  } catch (error) {
    return error instanceof RequestBodyError || error instanceof z.ZodError ? errorResponse(error) : unavailable();
  }
}

export async function DELETE(request: Request): Promise<Response> {
  let config: ReturnType<typeof hostedConfig>;
  try { config = hostedConfig(); } catch { return unavailable(); }
  if (!config.hosted) return Response.json({ error: "HOSTED_ONLY" }, { status: 404 });
  const originError = invalidHostedOrigin(request, config);
  if (originError) return originError;
  try {
    const { store } = await hostedRuntime(config);
    const guard = await guardHostedRequest(request, {}, config, store!);
    if (guard) return guard;
    await store!.revokeSession(parseSessionCookie(request.headers.get("cookie")));
    return Response.json({ hosted: true, configured: true, authenticated: false, canReview: false }, { headers: { "Set-Cookie": cookie("", 0), "Cache-Control": "no-store" } });
  } catch { return unavailable(); }
}
