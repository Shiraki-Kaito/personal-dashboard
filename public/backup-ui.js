import { sessionFetch as fetch } from "./session-connection.js";
import { confirmAction } from "./confirm.js";
import { assertBackupEnvelope } from "./backup-format.js?v=groups1";
import {encryptBackup,decryptBackup,isEncryptedBackup,maximumEncryptedBytes,maximumPlaintextBytes} from './backup-crypto.js';
const fileInput = document.getElementById("backupFile"),
  status = document.getElementById("backupStatus"),
  restore = document.getElementById("restoreBackup");
let backup = null,
  checksum = null;
const passphrase=document.getElementById('backupPassphrase');
const confirmation=document.getElementById('backupPassphraseConfirm');
const save=document.getElementById('saveEncryptedBackup');
save.onclick=async()=>{
  save.disabled=fileInput.disabled=true;
  try {
    if(passphrase.value!==confirmation.value)throw Error('確認用パスフレーズが一致しません');
    if([...passphrase.value].length<16)throw Error('パスフレーズは16文字以上にしてください');
    const response=await fetch('/api/backup');
    if(!response.ok)throw Error('バックアップを取得できません');
    const plaintext=await response.text();
    assertBackupEnvelope(JSON.parse(plaintext));
    const encrypted=await encryptBackup(plaintext,passphrase.value);
    const url=URL.createObjectURL(new Blob([JSON.stringify(encrypted)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='personal-dashboard-encrypted-'+new Date().toISOString().slice(0,10)+'.json';
    link.click();setTimeout(()=>URL.revokeObjectURL(url),60_000);
    status.textContent='暗号化ファイルのダウンロードを開始しました。保存先とファイルの存在を確認してください。パスフレーズは別の安全な場所で保管してください。';
  } catch(error) {status.textContent=error.message;}
  finally {passphrase.value=confirmation.value='';save.disabled=fileInput.disabled=false;}
};
async function call(body) {
  const response = await fetch("/api/backup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "バックアップを確認できません");
  return result;
}
fileInput.onchange = async () => {
  restore.disabled = true;
  backup = checksum = null;
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.disabled = save.disabled = true;
  try {
    if (file.size > maximumEncryptedBytes) throw Error("暗号化ファイルの上限12MiBを超えています");
    let candidate = JSON.parse(await file.text());
    if(isEncryptedBackup(candidate)) candidate=JSON.parse(await decryptBackup(candidate,passphrase.value));
    else if(file.size>maximumPlaintextBytes)throw Error('JSONの上限8MiBを超えています');
    assertBackupEnvelope(candidate);
    const plan = await call({ preview: true, backup: candidate });
    status.textContent =
      "未同期 " +
      plan.tasks +
      "件・Drive " +
      plan.driveFiles +
      "件・ノート関連 " + (plan.noteTaskLinks || 0) +
      "件・会議記録 " + (plan.meetingReports || 0) + "件・メール " +
      plan.agendaMessages +
      "件・手動分類 " + (plan.splitMessages || 0) + "通・案件記録 " + (plan.agendaCases || 0) +
      "件・予定操作 " +
      plan.agendaOperations +
      "件（" +
      plan.agendaAccounts +
      "アカウント）。" +
      (plan.conflicts.length
        ? "保存先に既存データがあるため復元を停止します。"
        : "空の保存先へ復元できます。GitHub・Googleへは自動送信しません。");
    if (!plan.conflicts.length && plan.entries) {
      backup = candidate;
      checksum = plan.checksum;
      restore.disabled = false;
    }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    passphrase.value=confirmation.value='';
    fileInput.value='';
    fileInput.disabled = save.disabled = false;
  }
};
restore.onclick = async () => {
  if (!backup || restore.disabled) return;
  if (
    !(await confirmAction(
      "バックアップを空の保存先へ復元します。GitHubの未同期操作と予定の登録記録は再照合待ちになります。予定をGoogleへ再送しません。",
      "復元する",
    ))
  )
    return;
  restore.disabled = fileInput.disabled = save.disabled = true;
  try {
    const result = await call({ restore: true, backup, checksum });
    status.textContent =
      result.restored +
      "項目を復元しました。画面を再読み込みし、取得状況を確認してください。";
    backup = checksum = null;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    fileInput.disabled = save.disabled = false;
  }
};
