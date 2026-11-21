const maximumBytes = 256 * 1024;
// 一覧更新と本文取得は既存の読み取りAPIを使う。別の接続・版を比較対象にしない。
export async function compareDraftSource(origin, text, api) {
  new NoteDraft({...origin,text});
  const view = await api({action:"refresh"});
  const scope = view.config && JSON.stringify([view.config.owner,view.config.repo,view.config.branch,view.config.folder]);
  if (!view.configured || view.stale || view.error || scope !== origin.scope)
    throw Error("接続範囲の変更または一覧取得の失敗により比較できません。下書きは保持しています。");
  const file = view.files.find(file => file.path === origin.path);
  if (!file?.readable) throw Error("元ノートが取得範囲外・削除済み、またはサイズ上限を超えています。");
  const note = await api({action:"read",path:file.path,sha:file.sha});
  if (note.commit !== view.commit || note.path !== origin.path || note.sha !== file.sha || typeof note.text !== "string")
    throw Error("比較中に元ノートの版が変わりました。再度比較してください。");
  const left=note.text.split("\n"), right=text.split("\n");
  let start=0, endLeft=left.length, endRight=right.length;
  while(start<endLeft && start<endRight && left[start]===right[start]) start++;
  while(endLeft>start && endRight>start && left[endLeft-1]===right[endRight-1]) {endLeft--;endRight--;}
  return {same:note.text===text,commit:note.commit,sourceCommitChanged:note.commit!==origin.commit,
    checkedAt:view.lastSuccess,startLine:start+1,sourceLines:left.slice(start,endLeft).join("\n"),draftLines:right.slice(start,endRight).join("\n")};
}
// 元の版と編集結果を分け、エクスポートをGitHub保存成功として扱わない。
export class NoteDraft {
  constructor(note) {
    if (!note || typeof note.text !== "string" || typeof note.path !== "string" ||
      note.path.split("/").some(part => !part || part === "." || part === ".." || /_L\.md$/i.test(part)) ||
      /[\\\u0000-\u001f]/.test(note.path) || !/\.md$/i.test(note.path) ||
      !/^[a-f0-9]{40}$/.test(note.commit)) throw Error("編集元のノートが不正です");
    this.path = note.path;
    this.commit = note.commit;
    this.original = note.text;
    this.text = note.text;
    this.exportedText = null;
  }
  get dirty() { return this.text !== this.original && this.text !== this.exportedText; }
  exportText() {
    if (new TextEncoder().encode(this.text).length > maximumBytes)
      throw Error("下書きはUTF-8で256KiB以内にしてください");
    return this.text;
  }
  markExported(text) { this.exportedText = text; }
  get filename() { return this.path.split("/").at(-1).replace(/\.md$/i, ".draft.md"); }
}
