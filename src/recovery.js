// 読み取りの一時障害だけを、永続化した予定で最大3回まで再取得する。
const retryDelaysMs = [60000, 5 * 60000, 15 * 60000];
export function nextRecovery(error, previous, now) {
  if (!["network", "remote", "rate"].includes(error.code)) return null;
  const attempt = previous?.attempt || 0;
  return {
    attempt: attempt + 1,
    nextAt:
      attempt < retryDelaysMs.length
        ? Math.max(now + retryDelaysMs[attempt], error.retryAt || 0)
        : null,
    errorCode: error.code,
  };
}
