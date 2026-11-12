import { googleRequest, DriveError } from "./drive-http.js";
import { random, challenge, exchange, googleConfigured } from "./drive-auth.js";
import { digest } from "./agenda-rules.js";
import {
  maximumAgendaAccounts,
  validAccountLabel,
} from "./agenda-account-rules.js";
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
export function agendaConnectionStatus(credential) {
  return {
    connected: !!credential && !credential.invalid,
    accessTokenExpiresAt: Number.isFinite(credential?.expires)
      ? new Date(credential.expires).toISOString()
      : null,
    refresh: {
      lastAttempt: credential?.lastRefreshAttemptAt || null,
      lastSuccess: credential?.lastRefreshedAt || null,
      count: credential?.refreshCount || 0,
      error: credential?.lastRefreshError || null,
    },
  };
}
async function responseText(response, maximumBytes) {
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximumBytes)
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
  return new TextDecoder().decode(bytes);
}

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
      if (response.status === 403) {
        const details = await responseText(response, 16 * 1024)
          .then(JSON.parse)
          .catch(() => ({}));
        const reasons = Array.isArray(details.error?.errors)
          ? details.error.errors.map((e) => e.reason)
          : [];
        if (
          details.error?.status === "RESOURCE_EXHAUSTED" ||
          reasons.some((reason) =>
            [
              "rateLimitExceeded",
              "userRateLimitExceeded",
              "dailyLimitExceeded",
              "quotaExceeded",
            ].includes(reason),
          )
        )
          throw new AgendaError(
            "Google APIの利用制限です",
            "rate",
            Date.now() + 60000,
          );
        throw new AgendaError(
          "追加権限またはGmail・Calendar APIの有効化を確認してください",
          "permission",
        );
      }
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
      const text = await responseText(response, 2 * 1024 * 1024);
      try {
        const result = JSON.parse(text);
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
  if (account.disconnectedAt || !credential || credential.invalid)
    throw new AgendaError(
      account.email + " の再接続が必要です",
      "authentication",
    );
  if (credential.expires > Date.now() + 60000) return credential.token;
  credential.lastRefreshAttemptAt = new Date().toISOString();
  await storage.put(key, credential);
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
      lastRefreshedAt: new Date().toISOString(),
      refreshCount: (credential.refreshCount || 0) + 1,
      lastRefreshError: null,
    });
    return grant.access_token;
  } catch (error) {
    await storage.put(key, {
      ...credential,
      lastRefreshError: "メール・カレンダーのトークン更新に失敗しました",
      ...(error instanceof DriveError && error.code === "authentication"
        ? { invalid: true }
        : {}),
    });
    throw new AgendaError(
      "メール・カレンダーのトークン更新に失敗しました",
      error.code || "authentication",
    );
  }
}
function connectionFailure(message, status) {
  const escaped = message.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
  return new Response(
    '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google接続の確認</title><main><h1>Google接続を確認してください</h1><p>' +
      escaped +
      '</p><p><a href="/?view=agenda&amp;manage=1">アカウント管理へ戻ってやり直す</a></p></main></html>',
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
export async function agendaConnect(
  request,
  env,
  storage,
  session,
  send = fetch,
) {
  if (!googleConfigured(env))
    return connectionFailure("Google OAuth設定が必要です", 503);
  const url = new URL(request.url),
    redirectUri = url.origin + "/auth/google/callback";
  if (url.pathname === "/auth/agenda/start") {
    let label = "";
    if (request.body) {
      const input = await request.json().catch(() => null);
      if (
        !input ||
        Array.isArray(input) ||
        typeof input !== "object" ||
        !validAccountLabel(input.label ?? "")
      )
        return Response.json(
          { error: "表示名は40文字以内で入力してください" },
          { status: 400 },
        );
      label = (input.label || "").trim();
    }
    const state = random(),
      verifier = random();
    await storage.put("agenda:flow", {
      state,
      verifier,
      sessionKey: session.key,
      expires: Date.now() + 600000,
      label,
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
    return connectionFailure("認可を最初からやり直してください", 403);
  await storage.delete("agenda:flow");
  if (url.searchParams.has("error") || !url.searchParams.get("code"))
    return connectionFailure(
      "追加認可は完了していません。既存接続を保持しました",
      400,
    );
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
    if (
      !accounts.some((a) => a.id === id) &&
      accounts.length >= maximumAgendaAccounts
    )
      throw new AgendaError(`接続は${maximumAgendaAccounts}アカウントまでです`);
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
        refreshCount: 0,
      });
      await tx.put("agenda:accounts", [
        ...accounts.filter((a) => a.id !== id),
        { id, email, calendar: "primary" },
      ]);
      // 再接続で既存の名前を変えず、認可完了前にも表示名を保存しない。
      if (flow.label && !(await tx.get("agenda:label:" + id)))
        await tx.put("agenda:label:" + id, flow.label);
    });
    const destination = new URL("/", url.origin);
    destination.search = new URLSearchParams({
      view: "agenda",
      accountId: id,
      connected: "1",
    });
    return new Response(null, {
      status: 303,
      headers: { Location: destination.pathname + destination.search },
    });
  } catch (error) {
    if (error instanceof AgendaError || error instanceof DriveError)
      return connectionFailure(error.message, 503);
    throw error;
  }
}

export async function agendaClient(env, storage, account, send, budget) {
  const request = googleAgendaClient(
    await agendaToken(env, storage, account, send),
    send,
    budget,
  );
  return async (...args) => {
    try {
      return await request(...args);
    } catch (error) {
      if (error instanceof AgendaError && error.code === "authentication") {
        const key = "agenda:credential:" + account.id,
          credential = await storage.get(key);
        if (credential)
          await storage.put(key, { ...credential, invalid: true });
      }
      throw error;
    }
  };
}
