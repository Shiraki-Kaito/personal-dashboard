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

test('アイドル期限で本人Cookieも拒否する',async()=>{
 const f=await flow(ownerId);
 const cookie=f.response.headers.getSetCookie().find(x=>x.startsWith('__Host-dashboard_session')).split(';')[0];
 f.data.get('session').lastActivity=Date.now()-30*60*1000;
 assert.equal(await authorized(new Request('https://unit.test/api/state',{headers:{cookie}}),f.storage),null);
});
test('OAuthの期限切れと再送をサーバーで拒否し交換しない',async()=>{
 const data=new Map(),storage={get:async k=>data.get(k),put:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k)};
 const start=await login(new Request('https://unit.test/auth/login'),env,storage);
 const cookie=start.headers.get('set-cookie').split(';')[0];
 const state=new URL(start.headers.get('location')).searchParams.get('state');
 const request=new Request('https://unit.test/auth/callback?code=fixture&state='+state,{headers:{cookie}});
 data.get('auth:flow').expires=0;
 assert.equal((await login(request,env,storage,()=>assert.fail())).status,403);
 data.delete('auth:flow');
 assert.equal((await login(request,env,storage,()=>assert.fail())).status,403);
});

test('管理者が世代を更新すると既存セッションを拒否する',async()=>{
 const f=await flow(ownerId);
 const cookie=f.response.headers.getSetCookie().find(x=>x.startsWith('__Host-dashboard_session')).split(';')[0];
 assert.equal(await authorized(new Request('https://unit.test/api/state',{headers:{cookie}}),f.storage,{SESSION_GENERATION:'incident-2'}),null);
});

test('外部IdPでの失効・異なる本人・障害を再照合して拒否する',async()=>{
 for(const mode of ['revoked','other','network','ok']) {
  const f=await flow(ownerId);
  const cookie=f.response.headers.getSetCookie().find(x=>x.startsWith('__Host-dashboard_session')).split(';')[0];
  const request=new Request('https://unit.test/api/state',{headers:{cookie}});
  f.data.get('session').identityCheckedAt=Date.now()-5*60*1000;
  const send=async()=>{if(mode==='network')throw Error('network');return Response.json({node_id:mode==='other'?'other':ownerId},{status:mode==='revoked'?401:200});};
  if(mode==='network')await assert.rejects(authorized(request,f.storage,{},send));
  else assert.equal(!!await authorized(request,f.storage,{},send),mode==='ok');
 }
});
