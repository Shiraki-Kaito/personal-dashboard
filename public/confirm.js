export async function confirmAction(message, confirmLabel = "続ける") {
  const dialog = document.getElementById("confirmDialog");
  if (dialog.open) return false;
  document.getElementById("confirmMessage").textContent = message;
  dialog.querySelector('button[value="confirm"]').textContent = confirmLabel;
  // Escapeや背景クリックが以前の「破棄」を再利用しないよう毎回初期化する。
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.onclose = () => {
      dialog.onclose = null;
      resolve(dialog.returnValue === "confirm");
    };
  });
}
export const confirmDiscard = (message) =>
  confirmAction(message, "破棄して続ける");
