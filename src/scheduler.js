import { refreshDrive } from "./drive.js";

// 既存のセッション期限とDriveの分割取得を同じAlarmで調停する。
export async function nextAlarmAt(storage, now = Date.now()) {
  const [session, flow, job, recovery, agendaFlow] = await Promise.all([
    storage.get("session"),
    storage.get("drive:flow"),
    storage.get("drive:job"),
    storage.get("drive:recovery"),
    storage.get("agenda:flow"),
  ]);
  const candidates = [
    session?.expires,
    flow?.expires,
    job?.nextBatchAt,
    recovery?.nextAt,
    agendaFlow?.expires,
  ].filter(Number.isFinite);
  return candidates.length
    ? Math.max(now + 100, Math.min(...candidates))
    : null;
}
export async function scheduleAlarm(storage, now = Date.now()) {
  const at = await nextAlarmAt(storage, now);
  if (at === null) {
    if ((await storage.getAlarm()) !== null) await storage.deleteAlarm();
  } else await storage.setAlarm(at);
}
export async function runHourlyDrive(
  env,
  storage,
  send = fetch,
  now = Date.now(),
) {
  // 毎時取得で新しい試行枠を開始する。Alarmの障害再試行ではリセットしない。
  const recovery = await storage.get("drive:recovery");
  if (!recovery?.nextAt || recovery.nextAt <= now)
    await storage.delete("drive:recovery");
  await storage.put("drive:scheduler", {
    lastTriggeredAt: new Date(now).toISOString(),
    error: null,
  });
  try {
    const view = await refreshDrive(env, storage, send, now, "cron");
    await storage.put("drive:scheduler", {
      lastTriggeredAt: new Date(now).toISOString(),
      error:
        view.error ||
        (!view.connected ? "Google Driveの再接続が必要です" : null),
    });
    return view;
  } catch (error) {
    await storage.put("drive:scheduler", {
      lastTriggeredAt: new Date(now).toISOString(),
      error: "自動取得処理に失敗しました",
    });
    throw error;
  }
}
