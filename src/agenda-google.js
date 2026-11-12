import { googleRequest, DriveError } from "./drive-http.js";
import { random, challenge, exchange, googleConfigured } from "./drive-auth.js";
import { digest } from "./agenda-rules.js";
export const agendaScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events.owned",
];
export class AgendaError extends Error {
  constructor(message, code = "remote", retryAt = null) {
    super(message);
    this.code = code;
    this.retryAt = retryAt;
  }
}
export const agendaAccounts = async (storage) =>
  (await storage.get("agenda:accounts")) || [];
export function googleAgendaClient(
  token,
  send = fetch,
  budget = { remaining: 35 },
) {
  return async (
    service,
    resource,
    parameters = {},
    body = null,
    allowMissing = false,
  ) => {
    const root =
      service === "gmail"
        ? "https://gmail.googleapis.com/gmail/v1/users/me/"
        : "https://www.googleapis.com/calendar/v3/calendars/primary/";
    const url = new URL(root + resource);
    url.search = new URLSearchParams(parameters);
    for (let attempt = 0; ; attempt++) {
      if (--budget.remaining < 0)
        throw new AgendaError(
          "取得要求の上限です。全件照合は未完了です",
          "limit",
        );
      let response;
      try {
        response = await googleRequest(
          url,
          {
            method: body ? "POST" : "GET",
            headers: {
              Authorization: "Bearer " + token,
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
          send,
        );
      } catch (error) {
        if (!body && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        throw new AgendaError(
          "Googleとの通信失敗またはタイムアウトです",
          "network",
        );
      }
      if (allowMissing && response.status === 404) return null;
      if (response.status === 401)
        throw new AgendaError(
          "メール・カレンダーの再認可が必要です",
          "authentication",
        );
      if (response.status === 429 || response.headers.has("retry-after"))
        throw new AgendaError(
          "Google APIの利用制限です",
          "rate",
          Date.now() +
            Math.max(
              60000,
              (Number(response.headers.get("retry-after")) || 60) * 1000,
            ),
        );
      if (response.status === 403)
        throw new AgendaError(
          "追加権限またはGmail・Calendar APIの有効化を確認してください",
          "permission",
        );
      if (response.status === 409)
        throw new AgendaError(
          "同じ登録IDが存在します。結果を照合してください",
          "conflict",
        );
      if (response.status >= 500 && !body && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (!response.ok)
        throw new AgendaError("Google APIの取得・登録に失敗しました");
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 2 * 1024 * 1024)
            throw new AgendaError("応答が取得上限を超えました", "limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let index = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, index);
        index += chunk.length;
      }
      try {
        const result = JSON.parse(new TextDecoder().decode(bytes));
        if (!result || result.error) throw Error();
        return result;
      } catch {
        throw new AgendaError("Google APIの応答が不正です", "incomplete");
      }
    }
  };
}
export async function agendaToken(env, storage, account, send = fetch) {
  const key = "agenda:credential:" + account.id;
  const credential = await storage.get(key);
  if (!credential || credential.invalid)
    throw new AgendaError(
      account.email + " の再接続が必要です",
      "authentication",
    );
  if (credential.expires > Date.now() + 60000) return credential.token;
  try {
    const grant = await exchange(
      {
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
      },
      send,
    );
    await storage.put(key, {
      ...credential,
      token: grant.access_token,
      refresh: grant.refresh_token || credential.refresh,
      expires: Date.now() + grant.expires_in * 1000,
    });
    return grant.access_token;
  } catch (error) {
    if (error instanceof DriveError && error.code === "authentication")
      await storage.put(key, { ...credential, invalid: true });
    throw new AgendaError(
      "メール・カレンダーのトークン更新に失敗しました",
      error.code || "authentication",
    );
  }
}
export async function agendaConnect(
  request,
  env,
  storage,
  session,
  send = fetch,
) {
  if (!googleConfigured(env))
    return new Response("Google OAuth設定が必要です", { status: 503 });
  const url = new URL(request.url),
    redirectUri = url.origin + "/auth/google/callback";
  if (url.pathname === "/auth/agenda/start") {
    const state = random(),
      verifier = random();
    await storage.put("agenda:flow", {
      state,
      verifier,
      sessionKey: session.key,
      expires: Date.now() + 600000,
    });
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: agendaScopes.join(" "),
      access_type: "offline",
      prompt: "select_account consent",
      state,
      code_challenge: await challenge(verifier),
      code_challenge_method: "S256",
    });
    return Response.json({ authorizationUrl: auth.toString() });
  }
  const flow = await storage.get("agenda:flow");
  if (
    !flow ||
    flow.expires < Date.now() ||
    flow.sessionKey !== session.key ||
    flow.state !== url.searchParams.get("state")
  )
    return new Response("認可を最初からやり直してください", { status: 403 });
  await storage.delete("agenda:flow");
  if (url.searchParams.has("error") || !url.searchParams.get("code"))
    return new Response("追加認可は完了していません。既存接続を保持しました", {
      status: 400,
    });
  try {
    const grant = await exchange(
      {
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code: url.searchParams.get("code"),
        code_verifier: flow.verifier,
      },
      send,
    );
    if (
      !grant.refresh_token ||
      !agendaScopes.every((scope) => grant.scope?.split(" ").includes(scope))
    )
      throw new AgendaError(
        "Gmail読み取りと本人所有カレンダーの予定操作・継続接続の認可が必要です",
      );
    const read = googleAgendaClient(grant.access_token, send),
      profile = await read("gmail", "profile", { fields: "emailAddress" });
    const email = profile.emailAddress?.toLowerCase();
    if (typeof email !== "string" || email.length > 254 || !email.includes("@"))
      throw new AgendaError("接続アカウントを照合できません");
    const id = await digest(email),
      accounts = await agendaAccounts(storage);
    if (!accounts.some((a) => a.id === id) && accounts.length >= 5)
      throw new AgendaError("接続は5アカウントまでです");
    const calendar = await read("calendar", "events", {
      maxResults: "1",
      fields: "accessRole",
    });
    if (calendar.accessRole !== "owner")
      throw new AgendaError("本人所有のメインカレンダーを確認できません");
    await storage.transaction(async (tx) => {
      await tx.put("agenda:credential:" + id, {
        token: grant.access_token,
        refresh: grant.refresh_token,
        expires: Date.now() + grant.expires_in * 1000,
      });
      await tx.put("agenda:accounts", [
        ...accounts.filter((a) => a.id !== id),
        { id, email, calendar: "primary" },
      ]);
    });
    return new Response(null, { status: 303, headers: { Location: "/" } });
  } catch (error) {
    if (error instanceof AgendaError || error instanceof DriveError)
      return new Response(error.message, { status: 503 });
    throw error;
  }
}
