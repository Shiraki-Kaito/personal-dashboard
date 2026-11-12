import { InputError } from "./sync.js";
import { agendaAccounts } from "./agenda-google.js";
export async function displayAccounts(storage) {
  return Promise.all(
    (await agendaAccounts(storage)).map(async (account) => ({
      ...account,
      label: (await storage.get("agenda:label:" + account.id)) || "",
    })),
  );
}
export function validAccountLabel(value) {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
export async function saveAccountLabel(storage, input) {
  if (
    !validAccountLabel(input.label) ||
    !(await agendaAccounts(storage)).some((a) => a.id === input.accountId)
  )
    throw new InputError(
      "接続済みアカウントと40文字以内の表示名を指定してください",
    );
  await storage.put("agenda:label:" + input.accountId, input.label.trim());
}
