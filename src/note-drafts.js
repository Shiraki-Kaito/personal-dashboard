import { InputError } from "./sync.js";
import { excludedNotePath } from "./notes.js";
const prefix = "notes:draft:";
const maximumDrafts = 20;
const maximumRecordBytes = 100 * 1024; // Durable Objectの1値上限より余裕を残す。
const scopeOf = config => config ? JSON.stringify([config.owner,config.repo,config.branch,config.folder]) : null;
function validId(id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new InputError("下書きIDが不正です");
  return prefix + id;
}
// 専用バックアップには本文と出所だけを含め、認証情報や保存操作IDを取り込まない。
function portable(record) {
  const {id,scope,path,commit,text,updatedAt} = record;
  return {id,scope,path,commit,text,updatedAt};
}
function validateBackup(backup) {
  if (backup?.format !== "personal-dashboard-note-drafts" || backup.version !== 1 ||
    !Array.isArray(backup.records) || backup.records.length > maximumDrafts)
    throw new InputError("下書きバックアップの形式が不正です");
  const ids = new Set();
  return backup.records.map(value => {
    if (!value || typeof value !== "object") throw new InputError("下書きの形式が不正です");
    const record = portable(value);
    validId(record.id);
    let scope;
    try { scope = JSON.parse(record.scope); } catch { throw new InputError("接続範囲が不正です"); }
    if (!Array.isArray(scope) || scope.length !== 4 || scope.some(x => typeof x !== "string") ||
      !scope[0] || !scope[1] || typeof record.path !== "string" ||
      record.path.split("/").some(x => !x || x === "." || x === ".." || /_L\.md$/i.test(x)) ||
      /[\\\u0000-\u001f]/.test(record.path) || !/\.md$/i.test(record.path) ||
      !/^[a-f0-9]{40}$/.test(record.commit) || typeof record.text !== "string" ||
      typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt)) || ids.has(record.id))
      throw new InputError("下書きの出所・日時・IDが不正です");
    ids.add(record.id);
    if (new TextEncoder().encode(JSON.stringify({...record,revision:crypto.randomUUID(),operationId:crypto.randomUUID()})).length > maximumRecordBytes)
      throw new InputError("下書きの保存容量を超えています");
    return record;
  });
}
async function restorePlan(tx, records) {
  const current = await tx.list({prefix});
  const additions = [], existing = [];
  for (const record of records) {
    const previous = current.get(validId(record.id));
    if (!previous) additions.push(record);
    else if (JSON.stringify(portable(previous)) === JSON.stringify(record)) existing.push(record.id);
    else throw new InputError("同じIDの下書きに異なる内容があります。上書きせず復元を停止しました");
  }
  if (current.size + additions.length > maximumDrafts) throw new InputError("復元すると下書きの20件上限を超えます");
  return {additions,existing};
}
export async function noteDrafts(storage, input) {
  if (input.action === "draftExport") return {format:"personal-dashboard-note-drafts",version:1,
    exportedAt:new Date().toISOString(),records:[...(await storage.list({prefix})).values()].map(portable)};
  if (["draftRestorePreview","draftRestore"].includes(input.action)) {
    const records = validateBackup(input.backup);
    return storage.transaction(async tx => {
      const plan = await restorePlan(tx,records);
      if (input.action === "draftRestore") {
        if (input.confirmed !== true) throw new InputError("復元内容の確認が必要です");
        // 同一内容の再送は追加済みとして扱う。異なる内容は必ず停止する。
        for (const record of plan.additions) await tx.put(validId(record.id),{...record,revision:crypto.randomUUID(),operationId:crypto.randomUUID()});
      }
      return {added:plan.additions.map(({id,path})=>({id,path})),existing:plan.existing.length};
    });
  }
  if (input.action === "draftDelete") return storage.transaction(async tx => {
    const key = validId(input.id), previous = await tx.get(key);
    if (input.confirmed !== true || typeof input.revision !== "string" || !input.revision) throw new InputError("削除内容の確認が必要です");
    if (!previous) return {deleted:true};
    if (previous.revision !== input.revision) throw new InputError("確認後に下書きが変更されました。一覧を開き直してください");
    await tx.delete(key);
    return {deleted:true};
  });
  if (input.action === "draftList") {
    const scope = scopeOf(await storage.get("notes:config"));
    return {records:[...(await storage.list({prefix})).values()].map(({text,...record}) => ({...record,currentScope:record.scope===scope})), maximumDrafts};
  }
  if (input.action === "draftLoad") {
    const record = await storage.get(validId(input.id));
    if (!record) throw new InputError("下書きが見つかりません");
    return record;
  }
  if (input.action !== "draftSave") throw new InputError("下書きの操作が不正です");
  validId(input.id);
  if (typeof input.text !== "string" || typeof input.revision !== "string") throw new InputError("下書きの形式が不正です");
  return storage.transaction(async tx => {
    const key = validId(input.id), previous = await tx.get(key);
    // 応答だけ失われた再送は同じ操作ID・内容のときだけ同じ結果を返す。
    if (typeof input.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(input.operationId)) throw new InputError("保存操作IDが不正です");
    if (previous?.operationId === input.operationId && previous.text === input.text) return previous;
    if (input.revision !== (previous?.revision || "")) throw new InputError("別の画面で保存されています。入力をコピーし、保存済み下書きを開き直してください");
    let origin;
    if (previous) origin = previous;
    else {
      const config = await tx.get("notes:config"), cache = await tx.get("notes:cache");
      if (!config || input.scope !== scopeOf(config) || excludedNotePath(input.path) ||
        !cache?.files?.some(file => file.path === input.path && file.readable) || input.commit !== cache.commit)
        throw new InputError("編集元が変わりました。ノートを開き直してください");
      if ((await tx.list({prefix})).size >= maximumDrafts) throw new InputError("下書きは20件までです。既存の下書きを更新してください");
      origin = {id:input.id,scope:input.scope,path:input.path,commit:input.commit};
    }
    const record = {...origin,text:input.text,operationId:input.operationId,revision:crypto.randomUUID(),updatedAt:new Date().toISOString()};
    if (new TextEncoder().encode(JSON.stringify(record)).length > maximumRecordBytes) throw new InputError("下書きの保存容量を超えています（本文・情報合計100KiB）");
    await tx.put(key, record);
    return record;
  });
}
