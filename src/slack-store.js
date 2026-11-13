import { InputError } from "./sync.js";
export const maximumSlackWorkspaces = 5;
export async function slackWorkspaces(storage) {
  return (await storage.get("slack:workspaces")) || [];
}
// 既存同期ロジックへ渡す保存領域をワークスペースごとに分離する。
export function slackWorkspaceStore(storage, teamId) {
  const key = (name) => {
    if (!name.startsWith("slack:"))
      throw new InputError("Slack保存領域の指定が不正です");
    return "slack:workspace:" + teamId + ":" + name.slice(6);
  };
  return {
    // 更新トークンの交換には全接続共通の専用アプリ資格情報を使用する。
    get: (name) =>
      storage.get(name === "slack:appCredential" ? name : key(name)),
    put: (name, value) => storage.put(key(name), value),
    delete: (name) => storage.delete(key(name)),
    transaction: (fn) =>
      storage.transaction((tx) => fn(slackWorkspaceStore(tx, teamId))),
  };
}
export async function selectedSlackStore(storage, teamId) {
  const workspaces = await slackWorkspaces(storage);
  const selected = workspaces.find(
    (workspace) => workspace.teamId === (teamId || workspaces[0]?.teamId),
  );
  if (!selected)
    throw new InputError("接続済みSlackワークスペースを選択してください");
  return slackWorkspaceStore(storage, selected.teamId);
}
