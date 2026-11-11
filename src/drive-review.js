export class DriveReviewError extends Error {}
const maxUnreviewedFiles = 10000;

// ファイルごとに未確認の変更を集約する。確認時の版が古ければ新しい変更は残す。
export function unreadChanges(cache) {
  return (
    cache?.unreadChanges ??
    (cache?.changes || []).map((change) => ({
      ...change,
      changeId: `legacy:${change.detectedAt}:${change.id}`,
      firstDetectedAt: change.detectedAt,
      occurrences: 1,
    }))
  );
}
export function mergeUnread(previous, changes) {
  const pending = new Map(previous.map((change) => [change.id, change]));
  for (const change of changes) {
    const old = pending.get(change.id);
    pending.set(change.id, {
      ...change,
      events: [...new Set([...(old?.events || []), ...change.events])],
      changeId: crypto.randomUUID(),
      firstDetectedAt: old?.firstDetectedAt ?? change.detectedAt,
      occurrences: (old?.occurrences || 0) + 1,
    });
  }
  if (pending.size > maxUnreviewedFiles)
    throw new DriveReviewError(
      "未確認の変更が保存上限に達しました。確認済みにしてから再取得してください",
    );
  return [...pending.values()].sort(
    (a, b) => b.detectedAt - a.detectedAt || a.id.localeCompare(b.id),
  );
}
export function reviewChanges(cache, entries) {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.length > maxUnreviewedFiles ||
    entries.some(
      (entry) =>
        !entry ||
        typeof entry.id !== "string" ||
        typeof entry.changeId !== "string" ||
        entry.id.length > 256 ||
        entry.changeId.length > 512,
    )
  )
    throw new DriveReviewError("確認対象が不正です");
  const versions = new Map(entries.map((entry) => [entry.id, entry.changeId]));
  if (versions.size !== entries.length)
    throw new DriveReviewError("確認対象が重複しています");
  const before = unreadChanges(cache);
  const remaining = before.filter(
    (change) => versions.get(change.id) !== change.changeId,
  );
  return { remaining, acknowledged: before.length - remaining.length };
}
