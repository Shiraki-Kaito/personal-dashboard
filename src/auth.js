import { ownerId } from "./github.js";
const flowCookie = "__Host-dashboard_flow",
  sessionCookie = "__Host-dashboard_session";
const sessionSeconds = 12 * 60 * 60;
export const idleMilliseconds = 30 * 60 * 1000;
function encode(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
const digest = async (value) =>
  encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
function cookie(name, value, seconds) {
  return (
    name +
    "=" +
    value +
    "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" +
    seconds
  );
}
function readCookie(request, name) {
  return (request.headers.get("Cookie") || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + "="))
    ?.slice(name.length + 1);
}
function redirect(url, cookies) {
  const headers = new Headers({
    Location: url,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
}
export async function login(request, env, storage, send = fetch) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)
    return new Response("GitHub OAuth の設定待ちです。", { status: 503 });
  const url = new URL(request.url);
  const callback = url.origin + "/auth/callback";
  if (url.pathname === "/auth/login") {
    const verifier = random(),
      state = random();
    await storage.put("auth:flow", {key:await digest(state + "." + verifier),expires:Date.now()+600000});
    const auth = new URL("https://github.com/login/oauth/authorize");
    auth.search = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: callback,
      scope: "project",
      login: "Shiraki-Kaito",
      state,
      code_challenge: await digest(verifier),
      code_challenge_method: "S256",
    });
    return redirect(auth, [cookie(flowCookie, state + "." + verifier, 600)]);
  }
  const [state, verifier] = (readCookie(request, flowCookie) || "").split(".");
  if (
    !state ||
    !verifier ||
    url.searchParams.get("state") !== state ||
    !url.searchParams.get("code")
  )
    return new Response("認可を最初からやり直してください", { status: 403 });
  const flow = await storage.get("auth:flow");
  if (!flow || flow.expires <= Date.now() || flow.key !== await digest(state + "." + verifier))
    return new Response("認可を最初からやり直してください", {status:403});
  await storage.delete("auth:flow");
  const exchange = await send("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      redirect_uri: callback,
      code: url.searchParams.get("code"),
      code_verifier: verifier,
    }),
  });
  const grant = await exchange.json();
  if (!exchange.ok || !grant.access_token || grant.scope !== "project")
    return new Response("project 権限で再認可してください", { status: 403 });
  const identity = await send("https://api.github.com/user", {
    headers: {
      Authorization: "Bearer " + grant.access_token,
      "User-Agent": "personal-dashboard",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });
  if (!identity.ok || (await identity.json()).node_id !== ownerId)
    return new Response("利用者が異なります", { status: 403 });
  const session = random();
  const lifetime = Math.min(sessionSeconds, grant.expires_in ?? sessionSeconds);
  if (!Number.isFinite(lifetime) || lifetime <= 0)
    return new Response("認可期限が不正です", { status: 403 });
  const expires = Date.now() + lifetime * 1000;
  await storage.setAlarm(expires);
  await storage.put("session", {
    owner: ownerId,
    lastActivity: Date.now(),
    generation: env.SESSION_GENERATION || "1",
    identityCheckedAt: Date.now(),
    key: await digest(session),
    token: grant.access_token,
    expires,
  });
  return redirect("/", [
    cookie(flowCookie, "", 0),
    cookie(sessionCookie, session, lifetime),
  ]);
}
export async function authorized(request, storage, env = {}, send = fetch) {
  const value = readCookie(request, sessionCookie);
  if (!value || value.length !== 43) return null;
  const session = await storage.get("session");
  if (
    !session ||
    session.owner !== ownerId ||
    (session.generation || "1") !== (env.SESSION_GENERATION || "1") ||
    session.expires <= Date.now() ||
    (session.lastActivity ?? session.expires - sessionSeconds * 1000) + idleMilliseconds <= Date.now() ||
    (await digest(value)) !== session.key
  )
    return null;
  // 外部IdPの失効を最大5分で再照合。ネットワーク障害でも許可側へ倒さない。
  if (!session.identityCheckedAt || Date.now()-session.identityCheckedAt >= 5*60*1000) {
    const identity = await send("https://api.github.com/user", {
      headers:{Authorization:"Bearer "+session.token,"User-Agent":"personal-dashboard"},
      redirect:"manual",signal:AbortSignal.timeout(8000),
    });
    if (identity.status === 401) {
      await storage.delete("session"); return null;
    }
    if (!identity.ok) throw new Error("本人認可を再確認できません");
    if ((await identity.json()).node_id !== ownerId) {
      await storage.delete("session"); return null;
    }
    session.identityCheckedAt=Date.now();
    await storage.put("session",session);
  }
  if (!session.lastActivity || Date.now() - session.lastActivity >= 60000)
    await storage.put("session", {...session,lastActivity:Date.now()});
  return session;
}
export async function logout(storage) {
  await storage.delete("session");
  return redirect("/", [cookie(sessionCookie, "", 0)]);
}
