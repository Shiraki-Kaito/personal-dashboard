import { animate, stagger } from "motion";
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
function enter(nodes) {
  if (reduced.matches || !nodes.length) return;
  animate(
    nodes,
    { opacity: [0, 1], y: [9, 0] },
    { duration: 0.32, delay: stagger(0.045), ease: [0.2, 0.7, 0.3, 1] },
  );
}
enter(document.querySelectorAll("[data-enter]"));
for (const card of document.querySelectorAll(".surface")) {
  card.addEventListener("pointermove", (event) => {
    if (reduced.matches || event.pointerType === "touch") return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--pointer-x", event.clientX - rect.left + "px");
    card.style.setProperty("--pointer-y", event.clientY - rect.top + "px");
  });
}
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});
for (const button of document.querySelectorAll("[data-open]")) {
  button.addEventListener("click", () => {
    const dialog = document.getElementById(button.dataset.open);
    if (!dialog.open) {
      dialog.showModal();
      enter([dialog.querySelector(".dialog-body")]);
    }
  });
}
document
  .querySelectorAll("[data-close]")
  .forEach(
    (button) => (button.onclick = () => button.closest("dialog").close()),
  );
function showPanel(panel, focusId) {
  document.body.dataset.view = panel;
  const titles = {
    home: ["ホーム", "今、確認したいことをひと目で。"],
    agenda: ["メール・予定", "重要な連絡と、これからの予定を確認。"],
    drive: ["Drive", "チームの更新と個人作業を分けて確認。"],
    tasks: ["タスク", "GitHub Projectsの状態と期限を管理。"],
    slack: ["Slack", "接続したチャンネルの情報を確認。"],
    notes: ["ノート", "GitHubのノートを検索・閲覧。"],
  };
  const [title, description] = titles[panel] || titles.home;
  document.getElementById("workspaceTitle").textContent = title;
  document.getElementById("workspaceDescription").textContent = description;
  document
    .querySelectorAll(".sidebar nav .nav-button")
    .forEach((nav) => {
      const current = nav.dataset.panel === panel;
      nav.classList.toggle("active", current);
      if (current) nav.setAttribute("aria-current", "page");
      else nav.removeAttribute("aria-current");
    });
  if (focusId) {
    const target = document.getElementById(focusId);
    target.focus();
    target.scrollIntoView({
      block: "nearest",
      behavior: reduced.matches ? "instant" : "smooth",
    });
  }
  document.dispatchEvent(new CustomEvent("dashboard:view", { detail: panel }));
}
document.addEventListener("dashboard:show-panel", (event) =>
  showPanel(event.detail.panel, event.detail.focusId),
);
document.querySelectorAll("[data-focus]").forEach(
  (button) =>
    (button.onclick = () => {
      showPanel(button.dataset.panel, button.dataset.focus);
    }),
);
const clock = document.getElementById("dateLabel");
clock.textContent = new Date().toLocaleDateString("ja-JP", {
  month: "long",
  day: "numeric",
  weekday: "long",
});
document.addEventListener("dashboard:rows", (event) =>
  enter([...event.detail.nodes].slice(0, 8)),
);

const working = new Set();
document.addEventListener("dashboard:busy", (event) => {
  if (event.detail.busy) working.add(event.detail.service);
  else working.delete(event.detail.service);
  const button = document.getElementById("syncAll");
  button.disabled = working.size > 0;
  button.dataset.busy = String(working.size > 0);
});
document.getElementById("syncAll").onclick = () =>
  document.dispatchEvent(new CustomEvent("dashboard:refresh"));
