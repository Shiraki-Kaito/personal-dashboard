import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ownerId, taskTitle } from "../src/github.js";
import { settingsFixture } from "./project-fixture.js";

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
    if (url.pathname === "/repos/fixture/notes") return Response.json({default_branch:"main",private:false});
    if (url.pathname === "/repos/fixture/notes/commits/main") return Response.json({sha:"b".repeat(40),commit:{tree:{sha:"a".repeat(40)}}});
    if (url.pathname === "/repos/fixture/notes/git/trees/"+"a".repeat(40)) return Response.json({sha:"a".repeat(40),truncated:false,tree:[
      {path:"note.md",mode:"100644",type:"blob",sha:"c".repeat(40),size:0},
      {path:"private_L.md",mode:"100644",type:"blob",sha:"d".repeat(40),size:0},
    ]});
    const { query, variables } = await req.json();
    if (variables.settingsProject)
      return Response.json({ data: settingsFixture(cfg) });
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
  function boot(driveConfigured=false, lockdown=false) {
    const modules = [
      "worker",
      "notes",
      "health",
      "connection-recovery",
      "notes-http",
      "notes-search",
      "note-task-links",
      "note-drafts",
      "auth", "request-security", "security-monitor",
      "github",
      "sync",
      "catalog",
      "drive",
      "drive-groups", "drive-member-identity",
      "drive-group-display",
      "drive-review",
      "drive-history",
      "drive-auth",
      "drive-http",
      "scheduler",
      "home",
      "recovery",
      "backup",
      "agenda-backup",
      "agenda",
      "agenda-google",
      "agenda-rules",
      "agenda-datetime",
      "agenda-calendar",
      "agenda-home",
      "agenda-mail",
      "mail-retrieval",
      "agenda-priority",
      "mail-priority-rules",
      "mail-suggestions",
      "mail-intent",
      "drive-meetings",
      "weekly-drive",
      "progress-reports",
      "progress-backup",
      "progress-record-store",
      "progress-sources",
      "progress-evidence",
      "weekly-report",
      "mail-cases",
      "mail-case-splits",
      "mail-timing",
      "mail-body-coverage",
      "mail-body-retention",
      "mail-body-review",
      "mail-additional-timing",
      "timing-confirmations",
      "timing-cleanup",
      "timing-calendar",
      "agenda-labels",
      "agenda-account-rules",
      "agenda-management",
      "agenda-references",
      "slack-http",
      "slack-auth",
      "slack-store",
      "slack",
      "mail-scheduler",
      "calendar-scheduler",
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
          PUBLIC_ORIGIN: origin,
          SECURITY_LOCKDOWN: lockdown ? "true" : "false",
          GOOGLE_OAUTH_PUBLISHING_STATUS: "published",
          GITHUB_CLIENT_ID: "fixture",
          GITHUB_CLIENT_SECRET: "fixture",
          PROJECT_CONFIG: JSON.stringify(cfg),
          ...(driveConfigured ? {DRIVE_CONFIG:JSON.stringify({folderId:"root",includeSubfolders:true})} : {}),
        },
        outboundService: upstream,
        serviceBindings: {
          ASSETS: (req) => {
            const pathname = new URL(req.url).pathname;
            if (pathname === "/privacy.html")
              return Response.redirect(origin + "/privacy", 307);
            return new Response(
              pathname === "/privacy" ? "public policy" : "private dashboard",
            );
          },
        },
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
    assert.equal((await app.dispatchFetch("https://attacker.test/auth/login")).status,421);
    const policy = await request("/privacy");
    assert.equal(policy.status, 200);
    assert.equal(policy.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(policy.headers.get("cache-control"), "no-store");
    assert.equal(policy.headers.get("x-frame-options"), "DENY");
    assert.equal(await policy.text(), "public policy");
    for (const route of ["/manifest.webmanifest", "/icons/dashboard-192.png", "/icons/dashboard-512.png", "/icons/dashboard.svg"])
      assert.equal((await request(route)).status, 200);
    for (const route of ["/desktop-ui.js", "/app-install.js", "/install-guidance.js", "/note-draft.js", "/note-draft-ui.js", "/icons/not-public.txt"])
      assert.equal((await request(route)).status, 401);
    assert.equal((await request("/manifest.webmanifest", {})).status, 401);
    assert.equal((await request("/api/drive")).status, 401);
    assert.equal((await request("/api/security")).status,401);
    assert.equal((await request("/backup-crypto.js")).status,401);
    assert.equal((await request("/api/meetings")).status, 401);
    assert.equal((await request("/api/meetings",{action:"save"})).status, 401);
    assert.equal((await request("/drive-meetings-ui.js")).status, 401);
    assert.equal((await request("/weekly-report-ui.js")).status,401);
    for(const path of ["/progress-reports-ui.js","/progress-reports.css"])assert.equal((await request(path)).status,401);
    assert.equal((await request("/auth/google/progress-start",{})).status,401);
    assert.equal((await request("/auth/google/report-start",{})).status,401);
    for(const action of ["weekly","configureWeekly","reportView","reportGenerate","reportLoad","reportSave","reportExport","reportArchive","reportRestorePreview","reportRestore"])assert.equal((await request("/api/meetings",{action})).status,401);
    assert.equal((await request("/drive-groups-ui.js")).status, 401);
    assert.equal((await request("/api/drive",{group:{}})).status,401);
    assert.equal((await request("/api/drive",{display:{}})).status,401);
    assert.equal((await request("/api/home")).status, 401);
    assert.equal((await request("/home-ui.js")).status, 401);
    for (const asset of ["/overview-ui.js", "/overview-summary.js", "/compact-ui.css"]) assert.equal((await request(asset)).status,401);
    for (const route of ["/api/agenda", "/agenda-ui.js", "/timing-editor.js", "/timing-cleanup-ui.js", "/mail-case-editor.js", "/mail-split-editor.js", "/mail-split-manager.js"])
      assert.equal((await request(route)).status, 401);
    for (const action of ["reviewBody","timingView","saveTiming","timingCalendar","timingCleanupView","cleanupTimings","saveCase","splitCase","manageSplit"])
      assert.equal((await request("/api/agenda",{action})).status,401);
    assert.equal(
      (await request("/api/agenda", { action: "register", confirmed: true }))
        .status,
      401,
    );
    assert.equal((await request("/auth/agenda/start", {})).status, 401);
    for (const route of ["/api/slack", "/slack-ui.js", "/auth/slack/callback", "/api/notes", "/notes-ui.js", "/api/health", "/health-ui.js", "/mail-rules-ui.js", "/api/session", "/session-ui.js", "/session-connection.js", "/calendar-cards.js"])
      assert.equal((await request(route)).status, 401);
    for (const action of ["configure", "refresh", "addChannel", "review", "stop"])
      assert.equal((await request("/api/slack", {action})).status, 401);
    assert.equal((await request("/auth/slack/start", {})).status, 401);
    for(const action of ["draftList","draftLoad","draftSave","draftExport","draftRestorePreview","draftRestore","draftDelete","configure","refresh","read","search","stop","links","linkAdd","linkRemove"]) assert.equal((await request("/api/notes",{action})).status,401);
    for (const action of ["previewPriorityRules", "savePriorityRules", "label", "syncMail", "disconnect", "clearCache", "previewDelete", "deleteAccount", "cleanupReferences"])
      assert.equal((await request("/api/agenda", { action })).status, 401);
    assert.equal(
      (await request("/api/agenda", { action: "calendar" })).status,
      401,
    );
    for (const path of ["/api/backup", "/backup-ui.js", "/backup-format.js"])
      assert.equal((await request(path)).status, 401);
    assert.equal((await request("/api/backup", { restore: true })).status, 401);
    assert.equal((await request("/api/abandon", {})).status, 401);
    assert.equal(
      (
        await request("/api/drive", {
          acknowledge: [{ id: "fixture", changeId: "fixture" }],
        })
      ).status,
      401,
    );
    assert.equal((await request("/api/drive", { refresh: true })).status, 401);
    assert.equal((await request("/auth/google/start", {})).status, 401);
    assert.equal(
      (await request("/auth/google/callback?state=invalid")).status,
      401,
    );
    for (const action of [
      "state",
      "refresh",
      "edit",
      "retry",
      "discard",
      "home",
    ])
      assert.equal(
        (await request("/api/" + action, action === "state" ? null : {}))
          .status,
        401,
      );
    assert.equal((await authenticate()).status, 403);
    cookie = "__Host-dashboard_session=" + "A".repeat(43);
    for (const route of ["/api/notes", "/api/home", "/api/drive", "/api/agenda", "/api/health"])
      assert.equal((await request(route)).status,401);
    viewer = ownerId;
    const signedIn = await authenticate();
    assert.equal(signedIn.status, 303);
    cookie = signedIn.headers
      .getSetCookie()
      .find((x) => x.startsWith("__Host-dashboard_session"))
      .split(";")[0];
    assert.equal(await (await request("/")).text(), "private dashboard");
    for (const action of ["reviewBody","timingView","saveTiming","timingCalendar","timingCleanupView","cleanupTimings","saveCase","splitCase","manageSplit"]) {
      assert.equal((await request("/api/agenda",{action},"https://other.test")).status,403);
      assert.equal((await request("/api/agenda",{action})).status,409);
    }
    assert.equal((await request("/api/home")).status, 200);
    assert.equal((await request("/api/meetings")).status, 409);
    assert.equal((await request("/api/meetings",{action:"save"},"https://other.test")).status,403);
    for(const action of ["weekly","configureWeekly","reportView","reportGenerate","reportLoad","reportSave","reportExport","reportArchive","reportRestorePreview","reportRestore"])assert.equal((await request("/api/meetings",{action},"https://other.test")).status,403);
    assert.equal((await request("/auth/google/report-start",{},"https://other.test")).status,403);
    assert.equal((await request("/api/meetings",{action:"save"})).status,409);
    assert.equal((await request("/api/drive",{group:{}},"https://other.test")).status,403);
    assert.equal((await request("/api/drive",{display:{}},"https://other.test")).status,403);
    assert.equal((await request("/api/drive",{display:{}})).status,409);
    assert.equal((await request("/api/drive",{group:null})).status,409);
    assert.deepEqual(
      (await (await request("/api/agenda")).json()).accounts,
      [],
    );
    for (const action of ["previewPriorityRules", "savePriorityRules", "label", "syncMail", "disconnect", "clearCache", "previewDelete", "deleteAccount", "cleanupReferences"])
      assert.equal(
        (await request("/api/agenda", { action }, "https://other.test")).status,
        403,
      );
    assert.equal((await request("/api/notes", {action:"configure"}, "https://other.test")).status, 403);
    assert.equal((await request("/api/health", {})).status, 405);
    assert.equal((await request("/api/security",{})).status,405);
    const monitor = (await (await request("/api/security")).json()).monitoring;
    assert.equal(monitor.configured,false);
    assert.equal(monitor.alerts.some(item=>item.kind==='denied'),true);
    assert.equal((await (await request("/api/health")).json()).externalRequests, 0);
    const emptyNotes = await (await request("/api/notes")).json();
    assert.equal(emptyNotes.configured, false);
    assert.deepEqual(emptyNotes.files, []);
    for (const action of ["configure","read","search","refresh","stop","links","linkAdd","linkRemove"]) assert.equal((await request("/api/notes",{action},"https://other.test")).status,403);
    const configuredNotes = await request("/api/notes",{action:"configure",repository:"https://github.com/fixture/notes",confirm:true});
    assert.equal(configuredNotes.status,200);
    assert.deepEqual((await configuredNotes.json()).files.map(file=>file.path),["note.md"]);
    assert.equal((await request("/api/notes", {action:"read",path:"secret_L.md"})).status, 409);
    for (const action of ["previewPriorityRules", "savePriorityRules"]) {
      const reply = await request("/api/agenda", {action, accountId:"unknown", confirm:true, revision:null,
        rules:{prioritySenders:[],excludedSenders:[],priorityKeywords:[],excludedKeywords:[]}});
      assert.equal(reply.status,409);
      assert.match((await reply.json()).error,/接続済みのアカウント/);
    }
    assert.equal((await request("/mail-rules-ui.js")).status,200);
    const sessionInfo=await (await request("/api/session")).json();
    assert.deepEqual(Object.keys(sessionInfo),["expiresAt"]);
    assert.ok(sessionInfo.expiresAt>Date.now());
    assert.equal((await request("/api/session",{})).status,405);
    const emptySlack = await (await request("/api/slack")).json();
    assert.equal(emptySlack.configured, false);
    assert.deepEqual(emptySlack.workspaces, []);
    for (const action of ["configure", "refresh", "addChannel", "review", "stop"])
      assert.equal((await request("/api/slack", {action}, "https://other.test")).status, 403);
    assert.equal((await request("/auth/slack/start", {}, "https://other.test")).status, 403);
    const emptyCalendar = await request("/api/agenda", { action: "calendar" });
    assert.equal(emptyCalendar.status, 200);
    assert.equal((await emptyCalendar.json()).calendar.complete, false);
    assert.equal(
      (
        await request(
          "/api/agenda",
          { action: "calendar" },
          "https://other.test",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/agenda",
          { action: "refresh" },
          "https://other.test",
        )
      ).status,
      403,
    );
    assert.equal(
      (await request("/auth/agenda/start", {}, "https://other.test")).status,
      403,
    );
    const backup = await request("/api/backup");
    assert.match(backup.headers.get("Content-Disposition"), /attachment/);
    assert.equal((await backup.json()).version, 2);
    assert.equal(
      (await request("/api/backup", { restore: true }, "https://other.test"))
        .status,
      403,
    );
    assert.equal(
      (await request("/api/abandon", {}, "https://other.test")).status,
      403,
    );
    assert.equal(
      (await request("/api/home", { refresh: true }, "https://other.test"))
        .status,
      403,
    );
    const drive = await (await request("/api/drive")).json();
    assert.equal((await request("/auth/google/start", {}, "null")).status, 403);
    assert.equal(
      (await request("/auth/google/start", {}, "https://other.test")).status,
      403,
    );
    assert.equal(drive.configured, false);
    assert.equal(drive.connected, false);
    // 定期取得の内部RPCはログイン用の公開APIを増やさずに実行できる。
    const namespace = await app.getDurableObjectNamespace("DASHBOARD");
    await namespace.getByName("owner").runScheduled();
    const scheduled = await (await request("/api/drive")).json();
    assert.ok(scheduled.automatic.lastTriggeredAt);
    assert.ok(scheduled.automatic.error);
    assert.equal(scheduled.lastSuccess, null);
    assert.equal((await request("/api/runScheduled", {})).status, 404);
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
    const noteView = await (await request("/api/notes")).json();
    const draftInput = {action:"draftSave",id:crypto.randomUUID(),operationId:crypto.randomUUID(),revision:"",scope:JSON.stringify([noteView.config.owner,noteView.config.repo,noteView.config.branch,noteView.config.folder]),path:"note.md",commit:noteView.commit,text:"SQLite再起動の試験下書き"};
    assert.equal((await request("/api/notes",draftInput,"https://other.test")).status,403);
    const savedDraftResponse = await request("/api/notes",draftInput);
    assert.equal(savedDraftResponse.status,200);
    const savedDraft = await savedDraftResponse.json();
    await app.dispose();
    app = boot();
    rejectWrites = false;
    const restartedNotes=await (await request("/api/notes")).json();
    assert.equal(restartedNotes.configured,true);
    assert.deepEqual(restartedNotes.files.map(file=>file.path),["note.md"]);
    assert.deepEqual(await (await request("/api/notes",{action:"draftLoad",id:draftInput.id})).json(),savedDraft);
    assert.deepEqual(await (await request("/api/notes",draftInput)).json(),savedDraft);
    const draftBackup=await (await request("/api/notes",{action:"draftExport"})).json();
    for(const action of ["draftExport","draftRestorePreview","draftRestore","draftDelete"])
      assert.equal((await request("/api/notes",{action},"https://other.test")).status,403);
    assert.equal((await request("/api/notes",{action:"draftDelete",id:savedDraft.id,revision:savedDraft.revision,confirmed:true})).status,200);
    const restoreDrafts={action:"draftRestore",backup:draftBackup,confirmed:true};
    assert.equal((await request("/api/notes",restoreDrafts)).status,200);
    await app.dispose(); app=boot();
    assert.equal((await (await request("/api/notes",{action:"draftLoad",id:savedDraft.id})).json()).text,savedDraft.text);
    assert.equal((await (await request("/api/notes",restoreDrafts)).json()).existing,1);
    const healthAfterRestart=await (await request("/api/health")).json();
    assert.equal(healthAfterRestart.pending.find(item=>item.service==="github").count,1);
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
    await app.dispose();app=boot(true);
    assert.equal((await request("/api/meetings")).status,200);
    const meeting={meetingDate:"2026-11-16",ownProgress:"試験用実績",ownNext:"試験用作業",teamProgress:"試験用チーム",teamNext:"試験用予定",risks:""};
    const generated=await (await request("/api/meetings",{action:"compose",...meeting})).json();
    const save={action:"save",...meeting,reports:generated.reports,scope:"root:true",expectedRevision:null};
    const saves=await Promise.all([request("/api/meetings",save),request("/api/meetings",save)]);
    assert.deepEqual(saves.map(response=>response.status).sort(),[200,409]);
    const persistedMeeting=(await (await request("/api/meetings")).json()).records[0];
    await app.dispose();app=boot(true);
    assert.deepEqual((await (await request("/api/meetings")).json()).records[0],persistedMeeting);
    assert.equal((await request("/api/meetings",save)).status,409);
    await request("/auth/logout", {});
    assert.equal((await request("/api/meetings")).status,401);
    assert.equal((await request("/api/state")).status, 401);
    await app.dispose();app=boot(true,true);
    assert.equal((await request("/api/state")).status,503);
    assert.equal((await request("/auth/login")).status,503);
  } finally {
    await app.dispose();
    await rm(persist, { recursive: true, force: true });
  }
});
