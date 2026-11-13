import { AppInstall } from "./app-install.js";
const button = document.getElementById("installApp");
const status = document.getElementById("installStatus");
const mode = matchMedia("(display-mode: standalone)");
const install = new AppInstall(render);
function render() {
  button.hidden = mode.matches || install.installed;
  button.disabled = install.busy || !install.event || !navigator.onLine;
  status.textContent = mode.matches
    ? "独立ウィンドウで起動しています。移動・サイズ変更・最小化は通常のWindows操作で行えます。"
    : install.message ||
      (install.event
        ? "このブラウザーから、独立したウィンドウで使うアプリとして追加できます。"
        : "Chrome／Edgeのメニューから「アプリをインストール」または「このサイトをアプリとしてインストール」を選べます。表示されない場合は、ブラウザーの対応や管理ポリシーを確認してください。");
  document.getElementById("offlineNotice").hidden = navigator.onLine;
}
button.onclick = () => install.prompt();
window.addEventListener("beforeinstallprompt", (event) => install.offer(event));
window.addEventListener("appinstalled", () => install.complete());
window.addEventListener("online", render);
window.addEventListener("offline", render);
mode.addEventListener("change", render);
render();
