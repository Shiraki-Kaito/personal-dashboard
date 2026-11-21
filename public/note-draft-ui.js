import { NoteDraft } from "./note-draft.js";
import { confirmAction } from "./confirm.js";

export function mountNoteDraft(reader) {
  let source = null, draft = null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-small";
  button.textContent = "編集用の下書きを作る";
  button.hidden = true;
  reader.append(button);
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "noteDraftTitle");
  dialog.innerHTML = `<h2 id="noteDraftTitle">ノートの下書き</h2>
    <p data-source></p><p>この画面だけの下書きです。GitHubには書き込みません。閉じる前にコピーまたはMarkdown保存してください。</p>
    <label>Markdown本文<textarea rows="16" style="width:100%;box-sizing:border-box" spellcheck="false"></textarea></label>
    <p role="status" data-status></p><div class="button-row"><button type="button" data-copy>コピー</button><button type="button" data-download>Markdown保存</button><button type="button" data-close>閉じる</button></div>`;
  dialog.style.width = "min(850px, 90vw)";
  document.body.append(dialog);
  const input = dialog.querySelector("textarea"), status = dialog.querySelector("[data-status]");
  button.onclick = () => {
    if (!source) return;
    draft = new NoteDraft(source);
    input.value = draft.text;
    dialog.querySelector("[data-source]").textContent = `${draft.path} ／ 元コミット ${draft.commit.slice(0, 8)}`;
    status.textContent = "GitHubへの反映：未実施";
    dialog.showModal();
    input.focus();
  };
  input.oninput = () => { draft.text = input.value; status.textContent = "下書きを編集中・GitHubには未反映"; };
  async function close() {
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
