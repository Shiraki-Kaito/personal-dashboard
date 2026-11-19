import { notesView, readNote, excludedNotePath } from "./notes.js";
import { NotesError } from "./notes-http.js";
import { InputError } from "./sync.js";

// API負荷と1回の応答時間を有界にし、続きは本人操作で取得する。
export const notesSearchBatchSize = 5;
const snippetCharacters = 180;
export function noteTextMatch(text, query) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - 50);
  return {
    line: text.slice(0, index).split("\n").length,
    snippet: (start ? "…" : "") + text.slice(start, start + snippetCharacters) +
      (start + snippetCharacters < text.length ? "…" : ""),
  };
}

// 現在の許可済み一覧だけを読み、検索語や本文は永続化しない。
export async function searchNotes(storage, input, send = fetch) {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length < 2 || query.length > 100 || /[\u0000-\u001f]/.test(query))
    throw new InputError("検索語は2〜100文字で入力してください");
  const view = await notesView(storage);
  if (!view.configured || view.stale || input.revision !== view.searchRevision)
    throw new InputError("一覧が古いか変更されています。一覧を更新して検索し直してください");
  const files = view.files.filter(file => !excludedNotePath(file.path));
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > files.length)
    throw new InputError("検索の開始位置が不正です");
  const result = {revision:view.searchRevision,query,total:files.length,scanned:0,skipped:0,matches:[],nextOffset:offset,error:null};
  const end = Math.min(files.length, offset + notesSearchBatchSize);
  for (let index = offset; index < end; index++) {
    const file = files[index];
    if (!file.readable) result.skipped++;
    else {
      try {
        const note = await readNote(storage, {path:file.path,sha:file.sha}, send);
        const match = noteTextMatch(note.text, query);
        if (match) result.matches.push({...file,...match});
        result.scanned++;
      } catch (error) {
        if (!(error instanceof NotesError)) throw error;
        result.error = {message:error.message,code:error.code,retryAt:error.retryAt};
        // 失敗したノートは検索済みに数えず、同じ位置から再試行する。
        result.nextOffset = index;
        return result;
      }
    }
    result.nextOffset = index + 1;
  }
  if (result.nextOffset === files.length) result.nextOffset = null;
  return result;
}
