import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ownerId, taskTitle } from "../src/github.js";

test("Worker経由で認可、並行編集、SQLite再起動後の復旧を確認", async () => {
  const persist = await mkdtemp(path.join(tmpdir(), "dashboard-test-"));
  const origin = "https://dashboard.test";
  const cfg = {
    project: "project",
    item: "task",
    status_field: "status",
    due_field: "due",
    options: [{ id: "a" }, { id: "b" }],
  };
  let status = "a",
    revision = 1,
    writes = 0,
    rejectWrites = true,
    viewer = "other";
  async function upstream(req) {
    const url = new URL(req.url);
    if (url.hostname === "github.com")
      return Response.json({ scope: "project", access_token: "fixture" });
    if (url.pathname === "/user") return Response.json({ node_id: viewer });
    const { query, variables } = await req.json();
    if (query.startsWith("mutation")) {
      if (rejectWrites) return Response.json({}, { status: 403 });
      writes++;
      status = variables.input.value.singleSelectOptionId;
      revision++;
      return Response.json({
        data: {
          updateProjectV2ItemFieldValue: { projectV2Item: { id: "task" } },
        },
      });
    }
    return Response.json({
      data: {
        viewer: { id: ownerId },
        node: {
          id: "task",
          updatedAt: String(revision),
          project: {
            id: "project",
            title: "ダッシュボード試作",
            owner: { id: ownerId },
            items: { totalCount: 1 },
          },
          content: { title: taskTitle },
          fieldValues: {
            pageInfo: { hasNextPage: false },
            nodes: [{ field: { id: "status" }, optionId: status }],
          },
        },
      },
    });
  }
  function boot() {
    const modules = [
      "worker",
      "auth",
      "github",
      "sync",
      "catalog",
      "drive",
      "drive-auth",
      "drive-http",
    ].map((name) => ({
      type: "ESModule",
      path: "src/" + name + ".js",
    }));
    return new Miniflare(
      convertV4MiniflareOptions({
        modules,
        modulesRoot: "src",
        compatibilityDate: "2026-11-10",
        durableObjects: {
          DASHBOARD: { className: "Dashboard", useSQLite: true },
        },
        resourcePersistencePath: persist,
        bindings: {
          GITHUB_CLIENT_ID: "fixture",
          GITHUB_CLIENT_SECRET: "fixture",
          PROJECT_CONFIG: JSON.stringify(cfg),
        },
        outboundService: upstream,
        serviceBindings: { ASSETS: () => new Response("private dashboard") },
      }),
    );
  }
  let app = boot(),
    cookie = "";
  const request = (route, body, customOrigin = origin) =>
    app.dispatchFetch(origin + route, {
      method: body ? "POST" : "GET",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        Origin: customOrigin,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  async function authenticate() {
    const start = await request("/auth/login");
    const state = new URL(start.headers.get("location")).searchParams.get(
      "state",
    );
    cookie = start.headers.get("set-cookie").split(";")[0];
    return request("/auth/callback?code=test&state=" + state);
  }
  try {
    assert.equal((await request("/api/drive")).status, 401);
    assert.equal((await request("/api/drive", { refresh: true })).status, 401);
    assert.equal((await request("/auth/google/start", {})).status, 401);
    assert.equal(
      (await request("/auth/google/callback?state=invalid")).status,
      401,
    );
    for (const action of ["state", "refresh", "edit", "retry", "discard"])
      assert.equal(
        (await request("/api/" + action, action === "state" ? null : {}))
          .status,
        401,
      );
    assert.equal((await authenticate()).status, 403);
    viewer = ownerId;
    const signedIn = await authenticate();
    assert.equal(signedIn.status, 303);
    cookie = signedIn.headers
      .getSetCookie()
      .find((x) => x.startsWith("__Host-dashboard_session"))
      .split(";")[0];
    assert.equal(await (await request("/")).text(), "private dashboard");
    const drive = await (await request("/api/drive")).json();
    assert.equal((await request("/auth/google/start", {}, "null")).status, 403);
    assert.equal(
      (await request("/auth/google/start", {}, "https://other.test")).status,
      403,
    );
    assert.equal(drive.configured, false);
    assert.equal(drive.connected, false);
    assert.equal(
      (await request("/api/drive", { refresh: true }, "https://other.test"))
        .status,
      403,
    );
    assert.equal(
      (await request("/api/edit", {}, "https://other.test")).status,
      403,
    );
    const { remote: base } = await (await request("/api/refresh", {})).json();
    const edit = { field: "status", value: "b", base };
    const attempts = await Promise.all([
      request("/api/edit", edit),
      request("/api/edit", edit),
    ]);
    assert.deepEqual(attempts.map((x) => x.status).sort(), [200, 409]);
    const failed = await attempts.find((x) => x.status === 200).json();
    assert.ok(failed.pending);
    await app.dispose();
    app = boot();
    rejectWrites = false;
    const recovered = await (await request("/api/state")).json();
    assert.equal(recovered.pending.id, failed.pending.id);
    const retries = await Promise.all([
      request("/api/retry", { id: failed.pending.id }),
      request("/api/retry", { id: failed.pending.id }),
    ]);
    assert.deepEqual(retries.map((x) => x.status).sort(), [200, 409]);
    assert.equal(writes, 1);
    assert.equal(
      (await (await request("/api/state")).json()).remote.status,
      "b",
    );
    await request("/auth/logout", {});
    assert.equal((await request("/api/state")).status, 401);
  } finally {
    await app.dispose();
    await rm(persist, { recursive: true, force: true });
  }
});
