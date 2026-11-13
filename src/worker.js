import { DurableObject } from "cloudflare:workers";
import { login, logout, authorized } from "./auth.js";
import { github, transport } from "./github.js";
import { synchronize, InputError } from "./sync.js";
import {
  projectsFrom,
  catalog,
  selectTask,
  taskStorage,
  abandonPending,
} from "./catalog.js";
import { googleConnect } from "./drive-auth.js";
import { driveView, refreshDrive, acknowledgeDrive } from "./drive.js";
import { DriveReviewError } from "./drive-review.js";
import { homeView } from "./home.js";
import { createBackup, backupPlan, restoreBackup } from "./backup.js";
import { scheduleAlarm, runHourlyDrive } from "./scheduler.js";
import { queueCalendarSync, runCalendarBatch } from "./calendar-scheduler.js";
import { queueMailSync, runMailBatch } from "./mail-scheduler.js";
import { agendaConnect, AgendaError } from "./agenda-google.js";
import {
  agendaView,
  refreshAgenda,
  renameAgendaAccount,
  disconnectAgendaAccount,
  clearAgendaAccountCache,
  previewAgendaAccountDeletion,
  deleteAgendaAccount,
  refreshAgendaCalendar,
  previewAppointment,
  registerAppointment,
  reconcileAppointment,
  reviewAgenda,
} from "./agenda.js";

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(env.DASHBOARD.getByName("owner").runScheduled());
  },
  async fetch(request, env) {
    const stub = env.DASHBOARD.getByName("owner");
    const response = await stub.fetch(request);
    const secured = new Response(response.body, response);
    for (const [name, value] of Object.entries({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    }))
      secured.headers.set(name, value);
    return secured;
  },
};
const actions = new Set([
  "agenda",
  "home",
  "abandon",
  "backup",
  "state",
  "refresh",
  "edit",
  "retry",
  "discard",
  "catalog",
  "drive",
]);
export class Dashboard extends DurableObject {
  // 読み取りを含む操作全体を同一インスタンスで直列化する。
  tail = Promise.resolve();
  serialize(action) {
    const current = this.tail.then(action);
    this.tail = current.catch(() => {});
    return current;
  }
  runScheduled() {
    return this.serialize(async () => {
      try {
        await queueMailSync(this.ctx.storage);
        await queueCalendarSync(this.ctx.storage);
        await runHourlyDrive(this.env, this.ctx.storage);
      } finally {
        await scheduleAlarm(this.ctx.storage);
      }
    });
  }
  alarm() {
    return this.serialize(async () => {
      await this.ctx.storage.transaction(async (tx) => {
        const session = await tx.get("session");
        if (session && session.expires <= Date.now())
          await tx.delete("session");
        const flow = await tx.get("drive:flow");
        if (flow && flow.expires <= Date.now()) await tx.delete("drive:flow");
        const agendaFlow = await tx.get("agenda:flow");
        if (agendaFlow && agendaFlow.expires <= Date.now())
          await tx.delete("agenda:flow");
      });
      try {
        const job = await this.ctx.storage.get("drive:job");
        const recovery = await this.ctx.storage.get("drive:recovery");
        if (
          (job && job.nextBatchAt <= Date.now()) ||
          (recovery?.nextAt && recovery.nextAt <= Date.now())
        )
          await refreshDrive(this.env, this.ctx.storage);
        else {
          const mailJob = await this.ctx.storage.get("agenda:mailJob");
          if (mailJob && mailJob.nextAt <= Date.now())
            await runMailBatch(this.env, this.ctx.storage);
          else await runCalendarBatch(this.env, this.ctx.storage);
        }
      } finally {
        await scheduleAlarm(this.ctx.storage);
      }
    });
  }
  fetch(request) {
    return this.serialize(async () => {
      try {
        return await this.handle(request);
      } finally {
        await scheduleAlarm(this.ctx.storage);
      }
    }).catch(() =>
      Response.json({ error: "処理失敗。再取得してください" }, { status: 503 }),
    );
  }
  async handle(request) {
    const { pathname, origin, searchParams } = new URL(request.url);
    const storage = this.ctx.storage;
    if (pathname === "/privacy" && request.method === "GET") {
      // Assets自身が拡張子なしURLを解決する。.htmlへ変換すると正規URLへ再転送される。
      return this.env.ASSETS.fetch(request);
    }
    if (
      request.method === "GET" &&
      ["/auth/login", "/auth/callback"].includes(pathname)
    )
      return login(request, this.env, storage);
    const session = await authorized(request, storage);
    if (!session) {
      if (pathname === "/" && request.method === "GET")
        return new Response(
          '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>個人ダッシュボード</title><main><h1>personal-dashboard</h1><p>GitHub ProjectsとGoogle Driveの情報を確認する、管理者本人専用のダッシュボードです。</p><p><a href="/auth/login">GitHubでログイン</a></p><p><a href="/privacy">プライバシーポリシー</a></p></main></html>',
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      return Response.json(
        { error: "本人のログインが必要です" },
        { status: 401 },
      );
    }
    if (request.method === "POST" && request.headers.get("Origin") !== origin)
      return Response.json({ error: "送信元が異なります" }, { status: 403 });
    if (request.method === "POST" && pathname === "/auth/logout")
      return logout(storage);
    if (
      (request.method === "POST" && pathname === "/auth/agenda/start") ||
      (request.method === "GET" &&
        pathname === "/auth/google/callback" &&
        (await storage.get("agenda:flow"))?.state === searchParams.get("state"))
    )
      return agendaConnect(request, this.env, storage, session);
    if (
      (request.method === "POST" && pathname === "/auth/google/start") ||
      (request.method === "GET" && pathname === "/auth/google/callback")
    )
      return googleConnect(request, this.env, storage, session);
    if (
      request.method === "GET" &&
      [
        "/",
        "/ui.js",
        "/task-drafts.js",
        "/confirm.js",
        "/home-ui.js",
        "/agenda-ui.js",
        "/backup-ui.js",
        "/backup-format.js",
        "/style.css",
        "/drive-ui.js",
        "/motion-ui.js",
        "/fonts/dm-sans-latin.woff2",
        "/fonts/OFL.txt",
        "/third-party-licenses.txt",
      ].includes(pathname)
    )
      return this.env.ASSETS.fetch(request);
    const action = pathname.slice("/api/".length);
    if (!pathname.startsWith("/api/") || !actions.has(action))
      return new Response(null, { status: 404 });
    if (
      ["drive", "home", "backup", "agenda"].includes(action)
        ? !["GET", "POST"].includes(request.method)
        : request.method !== (action === "state" ? "GET" : "POST")
    )
      return new Response(null, { status: 405 });
    let input = {};
    if (request.method === "POST") {
      if (request.headers.get("Content-Type") !== "application/json")
        return new Response(null, { status: 415 });
      try {
        input = await request.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      if (!input || typeof input !== "object" || Array.isArray(input))
        return new Response(null, { status: 400 });
    }
    try {
      if (action === "agenda") {
        if (request.method === "GET")
          return Response.json(
            await agendaView(this.env, storage, searchParams.get("accountId")),
          );
        const operations = {
          label: renameAgendaAccount,
          disconnect: disconnectAgendaAccount,
          clearCache: clearAgendaAccountCache,
          previewDelete: previewAgendaAccountDeletion,
          deleteAccount: deleteAgendaAccount,
          syncMail: async (env, storage, input) => {
            await queueMailSync(storage, Date.now(), "manual-batch");
            return agendaView(env, storage, input.accountId);
          },
          calendar: refreshAgendaCalendar,
          refresh: refreshAgenda,
          preview: previewAppointment,
          register: registerAppointment,
          reconcile: reconcileAppointment,
          review: reviewAgenda,
        };
        const operation = Object.hasOwn(operations, input.action)
          ? operations[input.action]
          : null;
        if (!operation)
          throw new InputError("メール・カレンダーの操作が不正です");
        return Response.json(await operation(this.env, storage, input));
      }
      if (action === "backup") {
        if (request.method === "GET")
          return Response.json(await createBackup(this.env, storage), {
            headers: {
              "Content-Disposition":
                'attachment; filename="personal-dashboard-backup-' +
                new Date().toISOString().slice(0, 10) +
                '.json"',
            },
          });
        if (input.preview === true)
          return Response.json(
            await backupPlan(this.env, storage, input.backup),
          );
        if (input.restore === true)
          return Response.json(
            await restoreBackup(
              this.env,
              storage,
              input.backup,
              input.checksum,
            ),
          );
        throw new InputError("復元内容の確認が必要です");
      }
      if (action === "home")
        return Response.json(
          await homeView(
            this.env,
            storage,
            transport(session.token),
            input.refresh === true,
          ),
        );
      if (action === "drive" && Object.hasOwn(input, "acknowledge")) {
        if (input.refresh)
          throw new DriveReviewError(
            "取得と確認済み操作は同時に実行できません",
          );
        return Response.json(
          await acknowledgeDrive(this.env, storage, input.acknowledge),
        );
      }
      if (action === "drive")
        return Response.json(
          request.method === "POST" &&
            input.refresh === true &&
            input.manual === true
            ? await refreshDrive(this.env, storage)
            : await driveView(this.env, storage),
        );
      const projects = projectsFrom(this.env.PROJECT_CONFIG);
      if (action === "abandon")
        return Response.json(await abandonPending(projects, input, storage));
      if (action === "catalog") {
        const projectId =
          input.projectId ||
          searchParams.get("projectId") ||
          projects[0].project;
        const project = projects.find((p) => p.project === projectId);
        if (!project) throw new InputError("対象Projectが不正です");
        const result = await catalog(
          project,
          transport(session.token),
          storage,
          input.refresh === true,
        );
        return Response.json({
          ...result,
          items: await Promise.all(
            result.items.map(async (item) => {
              const state = await taskStorage(
                storage,
                { ...project, item: item.id },
                projects.find((p) => p.item)?.item,
              ).get();
              return { ...item, pending: !!state?.pending };
            }),
          ),
          projectId,
          projects: projects.map((p) => ({
            id: p.project,
            title: p.title || "ダッシュボード試作",
            mode: p.kind || p.mode || "test",
            url: p.url,
          })),
        });
      }
      const defaultProject = projects.find((p) => p.item) || projects[0];
      const projectId =
        input.projectId ||
        searchParams.get("projectId") ||
        defaultProject.project;
      const itemId =
        input.itemId || searchParams.get("itemId") || defaultProject.item;
      const config = await selectTask(projects, projectId, itemId, storage);
      const result = await synchronize(
        action,
        input,
        config,
        github(config, transport(session.token)),
        taskStorage(storage, config, projects.find((p) => p.item)?.item),
      );
      return Response.json(result);
    } catch (e) {
      if (
        e instanceof InputError ||
        e instanceof DriveReviewError ||
        e instanceof AgendaError
      )
        return Response.json(
          { error: e.message, ...(e.code ? { code: e.code } : {}) },
          { status: 409 },
        );
      throw e;
    }
  }
}
