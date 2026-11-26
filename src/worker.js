import { searchNotes } from "./notes-search.js";
import { noteDrafts } from "./note-drafts.js";
import { noteTaskLinksView, changeNoteTaskLink } from "./note-task-links.js";
import { reviewMailBody } from "./mail-body-review.js";
import { previewProgressRestore, restoreProgressReports, archiveProgressReport, exportProgressReports, progressReportView, generateProgressReport, loadProgressReport, saveProgressReport } from "./progress-reports.js";
import { saveAgendaCase, saveAgendaSplit, manageAgendaSplit } from "./agenda-home.js";
import { saveDriveGroup } from "./drive-groups.js";
import { saveGroupDisplay } from "./drive-group-display.js";
import { meetingView, saveMeeting, composeMeetingReports } from "./drive-meetings.js";
import { configureWeekly, generateWeekly } from "./weekly-drive.js";
import { previewPriorityRules, savePriorityRules } from "./mail-priority-rules.js";
import { readTimingConfirmation, saveTimingConfirmation } from "./timing-confirmations.js";
import { timingCalendarSeed } from "./timing-calendar.js";
import { prepareTimingCleanup, cleanupTimings } from "./timing-cleanup.js";
import { healthView } from "./health.js";
import { notesView, configureNotes, refreshNotes, refreshScheduledNotes, readNote, stopNotes } from "./notes.js";
import { NotesError } from "./notes-http.js";
import { selectedSlackStore } from "./slack-store.js";
import { slackConnect, configureSlackApplication } from "./slack-auth.js";
import { SlackError } from "./slack-http.js";
import { slackMessagesView, addSlackChannel, queueSlackSync, runSlackBatch, reviewSlackMessage, stopSlack, dashboardSlackView, queueAllSlackSync, runNextSlackBatch } from "./slack.js";
import { cleanupAccountReferences } from "./agenda-references.js";
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
import { driveConfig, driveView, refreshDrive, acknowledgeDrive } from "./drive.js";
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
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    }))
      secured.headers.set(name, value);
    return secured;
  },
};
const actions = new Set([
  "meetings",
  "session",
  "notes",
  "health",
  "slack",
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
        await queueAllSlackSync(this.ctx.storage);
        await refreshScheduledNotes(this.ctx.storage);
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
        const slackFlow = await tx.get("slack:flow");
        if (slackFlow && slackFlow.expires <= Date.now()) await tx.delete("slack:flow");
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
          else {
            const calendarJob = await this.ctx.storage.get("agenda:calendarJob");
            if (calendarJob && calendarJob.nextAt <= Date.now()) await runCalendarBatch(this.env, this.ctx.storage);
            else await runNextSlackBatch(this.env, this.ctx.storage);
          }
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
    // 公開するのは一般的なアプリ名・アイコンだけ。個人データや実行用JSは本人認可の後。
    if (request.method === "GET" && ["/manifest.webmanifest", "/icons/dashboard-192.png", "/icons/dashboard-512.png", "/icons/dashboard.svg"].includes(pathname))
      return this.env.ASSETS.fetch(request);
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
          '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icons/dashboard-192.png"><meta name="theme-color" content="#10151d"><title>個人ダッシュボード</title><main><h1>personal-dashboard</h1><p>GitHub ProjectsとGoogle Driveの情報を確認する、管理者本人専用のダッシュボードです。</p><p><a href="/auth/login">GitHubでログイン</a></p><p><a href="/privacy">プライバシーポリシー</a></p></main></html>',
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      return Response.json(
        { error: "本人のログインが必要です" },
        { status: 401 },
      );
    }
    if (request.method === "POST" && request.headers.get("Origin") !== origin)
      return Response.json({ error: "送信元が異なります" }, { status: 403 });
    if ((request.method === "POST" && pathname === "/auth/slack/start") ||
        (request.method === "GET" && pathname === "/auth/slack/callback")) {
      try { return await slackConnect(request, this.env, storage, session); }
      catch (error) {
        if (error instanceof InputError || error instanceof SlackError)
          return Response.json({error:error.message},{status:409});
        throw error;
      }
    }
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
      (request.method === "POST" && ["/auth/google/start","/auth/google/report-start","/auth/google/progress-start"].includes(pathname)) ||
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
        "/overview-ui.js",
        "/overview-summary.js",
        "/compact-ui.css",
        "/mail-case-editor.js",
        "/mail-split-editor.js",
        "/mail-split-manager.js",
        "/timing-editor.js",
        "/timing-cleanup-ui.js",
        "/calendar-cards.js",
        "/agenda-ui.js",
        "/slack-ui.js",
        "/notes-ui.js",
        "/note-draft.js",
        "/note-draft-ui.js",
        "/health-ui.js",
        "/desktop-ui.js",
        "/app-install.js",
        "/install-guidance.js",
        "/session-connection.js",
        "/session-ui.js",
        "/mail-rules-ui.js",
        "/slack-app-manifest.json",
        "/backup-ui.js",
        "/backup-format.js",
        "/style.css",
        "/workspace-design.css",
        "/drive-ui.js",
        "/drive-groups-ui.js",
        "/drive-members-ui.js",
        "/drive-meetings-ui.js",
        "/weekly-report-ui.js",
        "/progress-reports-ui.js",
        "/progress-reports.css",
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
      ["drive", "home", "backup", "agenda", "slack", "notes", "meetings"].includes(action)
        ? !["GET", "POST"].includes(request.method)
        : request.method !== (["state", "health", "session"].includes(action) ? "GET" : "POST")
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
      if (action === "meetings") {
        const config=driveConfig(this.env);
        if(!config) throw new InputError("Driveの対象フォルダを設定してください");
        const scope=config.folderId+":"+config.includeSubfolders;
        if(request.method==="GET") return Response.json(await meetingView(storage,scope));
        if(input.action==="reportRestorePreview") return Response.json(await previewProgressRestore(storage,scope,input.backup));
        if(input.action==="reportRestore") return Response.json(await restoreProgressReports(storage,scope,input));
        if(input.action==="reportArchive") return Response.json(await archiveProgressReport(storage,scope,input));
        if(input.action==="reportExport") return Response.json(await exportProgressReports(storage,scope,input.id ?? null));
        if(input.action==="reportView") return Response.json(await progressReportView(storage,scope));
        if(input.action==="reportGenerate") return Response.json(await generateProgressReport(this.env,storage,scope,input));
        if(input.action==="reportLoad") return Response.json(await loadProgressReport(storage,scope,input.id));
        if(input.action==="reportSave") return Response.json(await saveProgressReport(storage,scope,input));
        if(input.action==="compose") return Response.json({reports:composeMeetingReports(input)});
        if(input.action==="save") return Response.json(await saveMeeting(storage,scope,input));
        if(input.action==="configureWeekly") return Response.json(await configureWeekly(storage,scope,input));
        if(input.action==="weekly") return Response.json(await generateWeekly(this.env,storage,scope,input));
        throw new InputError("会議記録の操作が不正です");
      }
      if (action === "session") return Response.json({expiresAt:session.expires});
      if (action === "health") return Response.json(await healthView(this.env, storage));
      if (action === "notes") {
        if (request.method === "POST" && ["draftList", "draftLoad", "draftSave", "draftExport", "draftRestorePreview", "draftRestore", "draftDelete"].includes(input.action)) return Response.json(await noteDrafts(storage, input));
        if (request.method === "GET") return Response.json(await notesView(storage));
        if (input.action === "links") return Response.json(await noteTaskLinksView(this.env, storage));
        if (["linkAdd", "linkRemove"].includes(input.action)) return Response.json(await changeNoteTaskLink(this.env, storage, input));
        if (input.action === "configure") return Response.json(await configureNotes(storage, input));
        if (input.action === "refresh") return Response.json(await refreshNotes(storage));
        if (input.action === "read") return Response.json(await readNote(storage, input));
        if (input.action === "search") return Response.json(await searchNotes(storage, input));
        if (input.action === "stop") return Response.json(await stopNotes(storage, input));
        throw new InputError("ノートの操作が不正です");
      }
      if (action === "slack") {
        if (request.method === "GET") return Response.json(await dashboardSlackView(this.env, storage, searchParams.get("teamId")));
        if (input.action === "configure") {
          await configureSlackApplication(this.env, storage, input);
          return Response.json(await dashboardSlackView(this.env, storage));
        }
        const scoped = await selectedSlackStore(storage, input.teamId);
        const operations = {
          addChannel: addSlackChannel,
          refresh: async (env, storage) => {
            await queueSlackSync(storage, Date.now(), "manual");
            return slackMessagesView(env, storage);
          },
          review: reviewSlackMessage,
          stop: stopSlack,
        };
        const operation = Object.hasOwn(operations, input.action) ? operations[input.action] : null;
        if (!operation) throw new InputError("Slackの操作が不正です");
        await operation(this.env, scoped, input);
        if (input.action === "stop") await storage.delete("slack:flow");
        return Response.json(await dashboardSlackView(this.env, storage, input.teamId));
      }
      if (action === "agenda") {
        if (request.method === "GET")
          return Response.json(
            await agendaView(this.env, storage, searchParams.get("accountId")),
          );
        const operations = {
          manageSplit: (_env, storage, input) => manageAgendaSplit(storage,input),
          splitCase: (_env, storage, input) => saveAgendaSplit(storage,input),
          saveCase: (_env, storage, input) => saveAgendaCase(storage,input),
          timingView: (_env, storage, input) => readTimingConfirmation(storage,input),
          timingCleanupView: (_env, storage, input) => prepareTimingCleanup(storage,input),
          cleanupTimings: (_env, storage, input) => cleanupTimings(storage,input),
          timingCalendar: (_env, storage, input) => timingCalendarSeed(storage,input),
          saveTiming: (_env, storage, input) => saveTimingConfirmation(storage,input),
          previewPriorityRules: (_env, storage, input) => previewPriorityRules(storage, input),
          savePriorityRules: async (env, storage, input) => {
            await savePriorityRules(storage, input);
            return agendaView(env, storage, input.accountId);
          },
          label: renameAgendaAccount,
          disconnect: disconnectAgendaAccount,
          clearCache: clearAgendaAccountCache,
          cleanupReferences: (_env, storage, input) => cleanupAccountReferences(storage, input),
          previewDelete: previewAgendaAccountDeletion,
          deleteAccount: deleteAgendaAccount,
          syncMail: async (env, storage, input) => {
            await queueMailSync(storage, Date.now(), "manual-batch");
            return agendaView(env, storage, input.accountId);
          },
          calendar: refreshAgendaCalendar,
          refresh: refreshAgenda,
          reviewBody: async (env,storage,input) => {
            await reviewMailBody(env,storage,input);
            return agendaView(env,storage,input.accountId);
          },
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
      if (action === "drive" && Object.hasOwn(input, "display")) {
        if(request.method!=="POST" || !input.display || input.group || input.refresh || input.acknowledge)throw new InputError("表示設定は単独で保存してください");
        const config=driveConfig(this.env);if(!config)throw new InputError("Driveの接続範囲が未設定です");
        await saveGroupDisplay(storage,config.folderId+":"+config.includeSubfolders,input.display);
        return Response.json(await driveView(this.env,storage));
      }
      if (action === "drive" && Object.hasOwn(input, "group")) {
        if (request.method !== "POST" || !input.group || typeof input.group !== "object" || input.refresh || input.acknowledge)
          throw new InputError("グループ保存は単独で実行してください");
        const config = await driveView(this.env, storage);
        if (input.group.scope !== config.folderId + ":" + config.includeSubfolders)
          throw new InputError("Driveの接続範囲が一致しません");
        await saveDriveGroup(storage, input.group);
        return Response.json(await driveView(this.env, storage));
      }
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
        e instanceof SlackError ||
        e instanceof NotesError ||
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
