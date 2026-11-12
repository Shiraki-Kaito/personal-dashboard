// ファイル名・識別子・資格情報を含めず、取得1回の結果を上限付きで保存する。
export const driveHistoryLimit = 72;
export async function beginDriveRun(storage, source, now) {
  if (await storage.get("drive:activeRun")) return;
  await storage.put("drive:activeRun", {
    startedAt: new Date(now).toISOString(),
    source,
  });
}
export async function finishDriveRun(storage, cache, now) {
  const active = await storage.get("drive:activeRun");
  if (!active) return;
  const history = (await storage.get("drive:history")) || [];
  await storage.put(
    "drive:history",
    [
      {
        ...active,
        finishedAt: new Date(now).toISOString(),
        outcome: cache.errorCode ? "failure" : "success",
        errorCode: cache.errorCode || null,
        fileCount: cache.files.length,
        folderCount: cache.folderCount ?? null,
      },
      ...history,
    ].slice(0, driveHistoryLimit),
  );
  await storage.delete("drive:activeRun");
}
