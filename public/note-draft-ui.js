import { NoteDraft } from "./note-draft.js";
import { confirmAction } from "./confirm.js";

export function mountNoteDraft(reader, api) {
  let source = null, draft = null;
  let saved = null, saving = false, pending = null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-small";
  button.textContent = "編集用の下書きを作る";
  button.hidden = true;
  reader.append(button);
  const dialog = document.createElement("dialog");
  dialog.className = "note-draft-dialog";
  dialog.setAttribute("aria-labelledby", "noteDraftTitle");
  dialog.innerHTML = `<h2 id="noteDraftTitle">ノートの下書き</h2>
    <p data-source></p><p>「下書きを保存」で本人専用サーバーへ保存します。自動保存ではありません。GitHubには書き込みません。</p>
    <label>Markdown本文<textarea rows="16" spellcheck="false"></textarea></label>
    <p role="status" data-status></p><div class="button-row"><button type="button" data-save>下書きを保存</button><button type="button" data-copy>コピー</button><button type="button" data-download>Markdown保存</button><button type="button" data-close>閉じる</button></div>`;
  document.body.append(dialog);
  const input = dialog.querySelector("textarea"), status = dialog.querySelector("[data-status]");
  function open(note, record = null) {
    draft = new NoteDraft(note);
    saved = record || {id:crypto.randomUUID(),scope:note.scope,path:note.path,commit:note.commit,revision:""};
    pending = null;
    input.value = draft.text;
    dialog.querySelector("[data-source]").textContent = `${draft.path} ／ 元コミット ${draft.commit.slice(0, 8)}`;
    status.textContent = record ? "保存済み下書きを復元しました。元ノートの最新版との照合はしていません。GitHubには未反映です。" : "下書きは未保存・GitHubには未反映";
    dialog.showModal();
    input.focus();
  }
  button.onclick = () => { if (source) open(source); };
  const restore = document.createElement("button"), list = document.createElement("div");
  restore.className = "button button-small";
  list.className = "note-draft-list";
  restore.type = "button"; restore.textContent = "保存済みの下書きを開く";
  document.getElementById("notesRefresh").after(restore);
  document.getElementById("notesStatus").after(list);
  restore.onclick = async () => {
    restore.disabled = true;
    try {
      const view = await api({action:"draftList"}); list.replaceChildren();
      if (!view.records.length) list.textContent = "保存済み下書きはありません。";
      for (const record of view.records) {
        const item = document.createElement("button"); item.type="button";
        item.textContent = `${record.path} ／ ${new Date(record.updatedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}${record.currentScope ? "" : " ／ 以前の接続範囲"}`;
        item.onclick = async () => {
          item.disabled = true;
          try { const loaded = await api({action:"draftLoad",id:record.id}); open(loaded, loaded); }
          catch (error) { list.append(document.createTextNode(error.message)); }
          finally { item.disabled = false; }
        }; list.append(item);
      }
    } catch (error) { list.textContent = error.message; }
    finally { restore.disabled = false; }
  };
  dialog.querySelector("[data-save]").onclick = async () => {
    if (saving) return;
    saving = true; input.disabled = true;
    for (const control of dialog.querySelectorAll("button")) control.disabled = true;
    try {
      const text = draft.exportText();
      if (!pending || pending.text !== text) pending = {...saved,action:"draftSave",text,operationId:crypto.randomUUID()};
      saved = await api(pending);
      if (saved.text !== text) throw Error("保存結果が一致しません。入力をコピーして保存済み一覧を確認してください。");
      draft.markExported(text); pending = null;
      status.textContent = "下書きをサーバーへ保存しました。再起動後は保存済み一覧から復元できます。GitHubには未反映です。";
    } catch (error) { status.textContent = error.message + " 入力は保持しています。結果不明時は同じ内容で再試行してください。"; }
    finally { saving = false; input.disabled = false; for (const control of dialog.querySelectorAll("button")) control.disabled = false; }
  };
  input.oninput = () => { draft.text = input.value; status.textContent = "下書きを編集中・GitHubには未反映"; };
  async function close() {
    if (saving) return;
    if (draft?.dirty && !await confirmAction("コピー・保存していない変更があります。下書きを破棄して閉じますか？")) return;
    dialog.close(); input.value = ""; draft = null;
  }
  dialog.oncancel = event => { event.preventDefault(); void close(); };
  dialog.querySelector("[data-close]").onclick = close;
  dialog.querySelector("[data-copy]").onclick = async () => {
    const active = draft;
    try {
      const text = active.exportText();
      await navigator.clipboard.writeText(text);
      if (draft !== active) return;
      active.markExported(text);
      status.textContent = "コピーしました。GitHubには未反映です。";
    } catch { status.textContent = "コピーできませんでした。本文のサイズとクリップボードの許可を確認してください。"; }
  };
  dialog.querySelector("[data-download]").onclick = () => {
    try {
      const text = draft.exportText();
      const url = URL.createObjectURL(new Blob([text], {type:"text/markdown;charset=utf-8"}));
      const link = document.createElement("a"); link.href = url; link.download = draft.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // ブラウザーの保存完了は確認できないので破棄警告を解除しない。
      status.textContent = "ダウンロードを開始しました。保存先を確認してください。GitHubには未反映です。";
    } catch (error) { status.textContent = error.message; }
  };
  window.addEventListener("beforeunload", event => {
    if (draft?.dirty) { event.preventDefault(); event.returnValue = ""; }
  });
  return note => { source = note; button.hidden = !note; };
}
