import { AppInstall } from "./app-install.js";
import { installGuidance } from "./install-guidance.js";
const button = document.getElementById("installApp");
const status = document.getElementById("installStatus");
const mode = matchMedia("(display-mode: standalone)");
const install = new AppInstall(render);
function render() {
  const guidance = installGuidance({
    userAgent: navigator.userAgent, platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints, standalone: mode.matches,
    legacyStandalone: navigator.standalone, offered: !!install.event,
    installed: install.installed,
  });
  button.hidden = guidance.hideButton && !install.busy;
  button.disabled = install.busy || !install.event || !navigator.onLine;
  status.textContent = mode.matches || navigator.standalone === true
    ? guidance.message : install.message || guidance.message;
  document.getElementById("offlineNotice").hidden = navigator.onLine;
}
button.onclick = () => install.prompt();
window.addEventListener("beforeinstallprompt", (event) => install.offer(event));
window.addEventListener("appinstalled", () => install.complete());
window.addEventListener("online", render);
window.addEventListener("offline", render);
mode.addEventListener("change", render);
window.addEventListener("pageshow", render);
render();
