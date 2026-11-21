import { NoteDraft, compareDraftSource } from "./note-draft.js?v=compare1";
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
    <button type="button" data-compare>元ノートを取得して比較</button><section data-comparison hidden><p data-comparison-status role="status"></p><details><summary>異なる範囲を見る（共通の先頭・末尾を省略）</summary><h3>取得した元ノート</h3><pre data-source-lines></pre><h3>比較時の下書き</h3><pre data-draft-lines></pre></details></section>
    <p role="status" data-status></p><div class="button-row"><button type="button" data-save>下書きを保存</button><button type="button" data-copy>コピー</button><button type="button" data-download>Markdown保存</button><button type="button" data-close>閉じる</button></div>`;
  document.body.append(dialog);
  const input = dialog.querySelector("textarea"), status = dialog.querySelector("[data-status]");
  function open(note, record = null) {
    draft = new NoteDraft(note);
    saved = record || {id:crypto.randomUUID(),scope:note.scope,path:note.path,commit:note.commit,revision:""};
    pending = null;
    dialog.querySelector('[data-comparison]').hidden=true;
    input.value = draft.text;
    dialog.querySelector("[data-source]").textContent = `${draft.path} ／ 元コミット ${draft.commit.slice(0, 8)}`;
    status.textContent = record ? "保存済み下書きを復元しました。比較ボタンで元ノートとの相違を確認できます。GitHubには未反映です。" : "下書きは未保存・GitHubには未反映";
    dialog.showModal();
    input.focus();
  }
  button.onclick = () => { if (source) open(source); };
  dialog.querySelector('[data-compare]').onclick = async event => {
    const control=event.currentTarget, active=draft, text=draft.text;
    const area=dialog.querySelector('[data-comparison]'), message=dialog.querySelector('[data-comparison-status]');
    control.disabled=true; area.hidden=false; message.textContent="元ノートを取得しています…";
    dialog.querySelector('[data-source-lines]').textContent="";
    dialog.querySelector('[data-draft-lines]').textContent="";
    try {
      const result=await compareDraftSource({...saved},text,api);
      if(draft!==active) return;
      if(draft.text!==text) throw Error("比較中に下書きを編集しました。もう一度比較してください。");
      message.textContent=`${result.same ? "本文は一致しています。" : `${result.startLine}行目から相違があります。`} 取得版 ${result.commit.slice(0,8)} ／ 一覧取得 ${new Date(result.checkedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}。${result.sourceCommitChanged ? "編集元とリポジトリのコミットが異なります（このファイルの変更とは限りません）。" : "編集元と同じコミットです。"} 取得した版との比較です。自動マージ・GitHub保存は行いません。`;
      dialog.querySelector('[data-source-lines]').textContent=result.sourceLines;
      dialog.querySelector('[data-draft-lines]').textContent=result.draftLines;
    } catch(error) { if(draft===active) message.textContent=`比較できません：${error.message}`; }
    finally { control.disabled=false; }
  };
  const restore = document.createElement("button"), list = document.createElement("div");
  restore.className = "button button-small";
  list.className = "note-draft-list";
  restore.type = "button"; restore.textContent = "保存済みの下書きを開く";
  document.getElementById("notesRefresh").after(restore);
  document.getElementById("notesStatus").after(list);
  const management = document.createElement("details");
  management.innerHTML = `<summary>下書きのバックアップ・復元</summary><p>保存済みの本文を含む専用JSONです。安全な場所に保管してください。通常のアプリバックアップとは別です。GitHubの元ノートは変更しません。ダウンロードは通常ブラウザーをご利用ください。</p><button type="button" data-backup>JSONを保存</button><label>復元するJSON<input type="file" accept=".json,application/json"></label><button type="button" data-import>復元内容を確認</button><p role="status"></p>`;
  list.after(management);
  const managementStatus = management.querySelector('[role="status"]');
  management.querySelector('[data-backup]').onclick = async event => {
    const control = event.currentTarget; control.disabled = true;
    try {
      const backup = await api({action:"draftExport"});
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:"application/json"}));
      const link = document.createElement("a"); link.href=url; link.download=`note-drafts-${new Date().toISOString().slice(0,10)}.json`; link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      managementStatus.textContent=`${backup.records.length}件のダウンロードを開始しました。端末の保存先を確認してください。`;
    } catch(error) { managementStatus.textContent=error.message; }
    finally { control.disabled=false; }
  };
  management.querySelector('[data-import]').onclick = async event => {
    const control=event.currentTarget; control.disabled=true;
    try {
      const file=management.querySelector('input').files[0];
      // JSONのエスケープ・整形による増分を含めた上限。各レコードはサーバーでも検証する。
      if (!file || file.size > 16*1024*1024) throw Error("16MiB以内の下書きJSONを選択してください");
      const backup=JSON.parse(await file.text());
      const plan=await api({action:"draftRestorePreview",backup});
      if (!await confirmAction(`追加 ${plan.added.length}件／同じ内容の保存済み ${plan.existing}件。既存の内容は上書きしません。GitHubには書き込みません。\n${plan.added.map(x=>x.path).join('\n')}`,"下書きを復元")) return;
      const result=await api({action:"draftRestore",backup,confirmed:true});
      managementStatus.textContent=`復元完了：追加${result.added.length}件、保存済み${result.existing}件。`;
      await restore.onclick();
    } catch(error) { managementStatus.textContent=`復元できませんでした：${error.message}`; }
    finally { control.disabled=false; }
  };
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
        };
        const remove=document.createElement("button"); remove.type="button"; remove.textContent="この下書きを削除";
        remove.onclick=async()=>{
          remove.disabled=true;
          try {
            if (!await confirmAction(`${record.path}\n保存日時：${new Date(record.updatedAt).toLocaleString("ja-JP")}\nこの保存済み下書きを削除します。元に戻すには専用JSONのバックアップが必要です。必要なら先にバックアップしてください。GitHubの元ノートは削除しません。`,"下書きを削除")) return;
            await api({action:"draftDelete",id:record.id,revision:record.revision,confirmed:true});
            await restore.onclick();
          } catch(error) { managementStatus.textContent=error.message; }
          finally { remove.disabled=false; }
        };
        const row=document.createElement("div"); row.append(item,remove); list.append(row);
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
  input.oninput = () => { draft.text = input.value; dialog.querySelector('[data-comparison]').hidden=true; status.textContent = "下書きを編集中・GitHubには未反映"; };
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
