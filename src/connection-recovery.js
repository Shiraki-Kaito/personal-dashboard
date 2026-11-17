// 保存された状態・エラー種別から、再送せずに復旧の案内を決める。
export function connectionRecovery(state, errorCode, retryAt, now, stopped = false) {
  // 成功後に残った過去のエラー種別だけで、再認可や利用制限を案内しない。
  const currentError = ["error", "retrying", "disconnected"].includes(state) ? errorCode : null;
  if (stopped)
    return { kind: "reconnect", label: "再接続の案内へ", message: "接続停止中です。同じアカウントで再認可して再開してください。" };
  if (["authentication", "auth", "permission", "forbidden"].includes(currentError) || state === "disconnected")
    return { kind: "reconnect", label: "再接続の案内へ", message: "本人の再認可または対象の閲覧権限・API設定の確認が必要です。再認可は自動実行しません。" };
  if (["running", "queued", "retrying"].includes(state))
    return { kind: "wait", label: "取得の進行を確認", message: "取得・再試行の進行を確認してください。前回成功の一覧を保持し、並行して新しい取得を開始しません。" };
  if (currentError === "rate" || (state === "error" && Number(retryAt) > now))
    return { kind: "wait", label: "待機・再取得の案内へ", message: "利用制限または待機時間があります。再試行可能時刻を確認し、連続して取得を押さないでください。" };
  if (["not_found", "deleted"].includes(currentError))
    return { kind: "source", label: "対象の設定を確認", message: "元の対象が存在するか、閲覧権限があるか確認してください。保存情報は自動削除しません。" };
  if (state === "limited")
    return { kind: "coverage", label: "確認範囲・続きを開く", message: "取得は成功しましたが、未取得の続きや本文の確認範囲に制限があります。元サービスも確認してください。" };
  return { kind: "refresh", label: "取得・復旧の画面へ", message: "対象の画面で取得状況を確認してください。このボタンは取得・予定の再登録を実行しません。" };
}
