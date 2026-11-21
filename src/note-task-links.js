import { projectsFrom } from "./catalog.js";
import { notesView, excludedNotePath } from "./notes.js";
import { InputError } from "./sync.js";

const maximumLinks = 200;
const taskListFreshMs = 2 * 60 * 1000;
const idPattern = /^[A-Za-z0-9_-]{1,160}$/;
const scopeOf = config => config ? JSON.stringify([config.owner, config.repo, config.branch, config.folder]) : null;
const identity = link => JSON.stringify([link.scope, link.path, link.projectId, link.itemId]);

// 本文・トークン・タスクのコピーは保存せず、参照先の識別子だけを保持する。
export function normalizeNoteTaskLinks(value) {
  if (!value || !Array.isArray(value.records) || value.records.length > maximumLinks)
    throw new InputError("ノート関連の保存形式が不正です");
  const records = value.records.map(link => {
    let scope;
    try { scope = JSON.parse(link.scope); } catch { throw new InputError("ノートの接続範囲が不正です"); }
    if (!Array.isArray(scope) || scope.length !== 4 || scope.some(part => typeof part !== "string" || part.length > 1000) ||
      typeof link.path !== "string" || !/\.md$/i.test(link.path) || link.path.length > 1000 ||
      /[\\\u0000-\u001f\u007f]/.test(link.path) || link.path.split("/").some(part => !part || part === "." || part === "..") ||
      excludedNotePath(link.path) || typeof link.projectId !== "string" || typeof link.itemId !== "string" || !idPattern.test(link.projectId) || !idPattern.test(link.itemId))
      throw new InputError("ノート関連の参照先が不正です");
    return {scope:link.scope, path:link.path, projectId:link.projectId, itemId:link.itemId};
  });
  if (new Set(records.map(identity)).size !== records.length) throw new InputError("ノート関連が重複しています");
  return {revision: typeof value.revision === "string" ? value.revision : "", records};
}

async function savedLinks(storage) {
  return normalizeNoteTaskLinks((await storage.get("notes:taskLinks")) || {revision:"", records:[]});
}

export async function noteTaskLinksView(env, storage, now = Date.now()) {
  const notes = await notesView(storage, now), saved = await savedLinks(storage);
  const scope = scopeOf(notes.config), candidates = [];
  const sources = [];
  for (const project of projectsFrom(env.PROJECT_CONFIG)) {
    const cache = await storage.get("catalog:" + project.project);
    const lastSuccess = Date.parse(cache?.lastSuccess);
    const stale = !Number.isFinite(lastSuccess) || !!cache.error || now - lastSuccess > taskListFreshMs;
    sources.push({projectId:project.project, stale, lastSuccess:cache?.lastSuccess || null});
    for (const item of cache?.items || []) {
      if (item.editable) candidates.push({projectId:project.project, itemId:item.id, title:item.title,
        projectTitle:cache.title || project.project, stale});
    }
  }
  const records = saved.records.map(link => {
    const task = candidates.find(item => item.projectId === link.projectId && item.itemId === link.itemId);
    return {...link, title:task?.title || "取得一覧で参照できないタスク",
      available:link.scope === scope && notes.files.some(file => file.path === link.path) && !!task,
      stale:notes.stale || !task || task.stale};
  });
  return {revision:saved.revision, scope, records, candidates, sources, notesStale:notes.stale, maximumLinks};
}

export async function changeNoteTaskLink(env, storage, input, now = Date.now()) {
  await storage.transaction(async tx => {
    const saved = await savedLinks(tx);
    if (input.revision !== saved.revision) throw new InputError("別の画面で関連が変更されました。一覧を読み直してください");
    const link = normalizeNoteTaskLinks({records:[input.link]}).records[0];
    const key = identity(link), exists = saved.records.some(item => identity(item) === key);
    if (input.action === "linkAdd") {
      const view = await noteTaskLinksView(env, tx, now);
      const notes = await notesView(tx, now);
      if (view.scope !== link.scope || notes.stale || !notes.files.some(file => file.path === link.path) ||
        !view.candidates.some(item => item.projectId === link.projectId && item.itemId === link.itemId && !item.stale))
        throw new InputError("取得範囲または一覧が古いため追加できません。ノートとタスクの一覧を更新してください");
      if (!exists) saved.records.push(link);
      if (saved.records.length > maximumLinks) throw new InputError("関連は全体で200件までです。不要な関連を解除してください");
    } else if (input.action === "linkRemove") {
      saved.records = saved.records.filter(item => identity(item) !== key);
    } else throw new InputError("ノート関連の操作が不正です");
    await tx.put("notes:taskLinks", {...saved, revision:crypto.randomUUID()});
  });
  return noteTaskLinksView(env, storage, now);
}
