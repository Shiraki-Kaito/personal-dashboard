import test from "node:test";
import assert from "node:assert/strict";
import { login, authorized, logout } from "../src/auth.js";
import { ownerId } from "../src/github.js";
const env = { GITHUB_CLIENT_ID: "test", GITHUB_CLIENT_SECRET: "fixture" };
async function flow(nodeId) {
  const data = new Map(),
    storage = {
      get: (k) => data.get(k),
      put: (k, v) => data.set(k, v),
      delete: (k) => data.delete(k),
      setAlarm: async () => {},
    };
  const start = await login(
    new Request("https://unit.test/auth/login"),
    env,
    storage,
  );
  const url = new URL(start.headers.get("location"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const request = new Request(
    "https://unit.test/auth/callback?code=test&state=" +
      url.searchParams.get("state"),
    { headers: { cookie } },
  );
  const response = await login(request, env, storage, async (url) =>
    Response.json(
      url.endsWith("/user")
        ? { node_id: nodeId }
        : { scope: "project", access_token: "fixture" },
    ),
  );
  return { response, storage, data };
}
test("本人以外にはセッションを発行しない", async () => {
  const f = await flow("other");
  assert.equal(f.response.status, 403);
  assert.equal(f.data.size, 0);
});
test("本人のCookieのみ許可し、失効・ログアウトを反映", async () => {
  const f = await flow(ownerId);
  assert.equal(f.response.status, 303);
  const cookie = f.response.headers
    .getSetCookie()
    .find((x) => x.startsWith("__Host-dashboard_session"))
    .split(";")[0];
  const req = new Request("https://unit.test/api/state", {
    headers: { cookie },
  });
  assert.ok(await authorized(req, f.storage));
  assert.equal(await authorized(new Request(req.url), f.storage), null);
  f.data.get("session").expires = 0;
  assert.equal(await authorized(req, f.storage), null);
  await logout(f.storage);
  assert.equal(f.data.size, 0);
});
test("state不一致でトークン交換を行わない", async () => {
  const r = await login(
    new Request("https://unit.test/auth/callback?state=invalid&code=test"),
    env,
    {},
    () => assert.fail(),
  );
  assert.equal(r.status, 403);
});
