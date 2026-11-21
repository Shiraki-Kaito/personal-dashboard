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
export async function noteDrafts(storage, input) {
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
