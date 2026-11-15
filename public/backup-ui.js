import { sessionFetch as fetch } from "./session-connection.js";
import { confirmAction } from "./confirm.js";
import { assertBackupEnvelope } from "./backup-format.js?v=groups1";
const fileInput = document.getElementById("backupFile"),
  status = document.getElementById("backupStatus"),
  restore = document.getElementById("restoreBackup");
let backup = null,
  checksum = null;
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
  fileInput.disabled = true;
  try {
    if (file.size > 8 * 1024 * 1024) throw Error("上限8MiBを超えています");
    const candidate = JSON.parse(await file.text());
    assertBackupEnvelope(candidate);
    const plan = await call({ preview: true, backup: candidate });
    status.textContent =
      "未同期 " +
      plan.tasks +
      "件・Drive " +
      plan.driveFiles +
      "件・メール " +
      plan.agendaMessages +
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
    fileInput.disabled = false;
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
  restore.disabled = fileInput.disabled = true;
  try {
    const result = await call({ restore: true, backup, checksum });
    status.textContent =
      result.restored +
      "項目を復元しました。画面を再読み込みし、取得状況を確認してください。";
    backup = checksum = null;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    fileInput.disabled = false;
  }
};
