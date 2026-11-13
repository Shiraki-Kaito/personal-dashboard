import { sessionConnection } from "./session-connection.js";
const dialog = document.getElementById("sessionDialog");
const status = document.getElementById("sessionStatus");
const check = document.getElementById("sessionCheck");
function render() {
  if (sessionConnection.expired && !dialog.open) {
    status.textContent =
      "ログインの有効期限が切れました。表示中の情報は最新とは限りません。ページを自動移動せず、入力中の画面を残しています。";
    dialog.showModal();
  }
  if (!sessionConnection.expired && dialog.open) dialog.close();
}
async function reconnect() {
  if (check.disabled) return;
  check.disabled = true;
  try {
    await sessionConnection.check();
    document.getElementById("sessionNotice").hidden = false;
    document.getElementById("sessionNoticeText").textContent =
      "ログインを再確認しました。保存操作は再送していません。対象画面で最新状態と入力内容を確認してください。";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    check.disabled = false;
    render();
  }
}
check.onclick = reconnect;
dialog.addEventListener("cancel", (event) => event.preventDefault());
document.addEventListener("dashboard:session-state", render);
window.addEventListener("focus", () => {
  if (sessionConnection.expired) reconnect();
});
// すでに読み込まれた画面で期限が切れていた場合も、認証情報を読まずに確認する。
render();
sessionConnection.check().catch(() => render());

document.getElementById("sessionNoticeClose").onclick = () => {
  document.getElementById("sessionNotice").hidden = true;
};
