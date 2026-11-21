// 端末判定は案内だけに使い、認証や利用可否の判定には使わない。
export function installGuidance({ userAgent = "", platform = "", maxTouchPoints = 0, standalone = false, legacyStandalone = false, offered = false, installed = false }) {
  const appleMobile = /iPhone|iPad|iPod/.test(userAgent) ||
    (platform === "MacIntel" && maxTouchPoints > 1);
  const running = standalone || legacyStandalone === true;
  if (running) return { hideButton: true, message: "独立したアプリ画面で起動しています。本人ログインとインターネット接続が必要です。" };
  if (installed) return { hideButton: true, message: "追加が完了しました。端末のアプリ一覧またはホーム画面から開いてください。" };
  if (offered) return { hideButton: false, message: "このブラウザーからアプリとして追加できます。" };
  return {
    hideButton: true,
    message: appleMobile
      ? "Safariでこのサイトを開き、共有メニューから「ホーム画面に追加」を選びます。「Webアプリとして開く」が表示される場合は有効にして追加してください。追加後の初回は本人ログインが必要になる場合があります。"
      : "ブラウザーのメニューに「アプリをインストール」などがあれば追加できます。iPhone・iPadは下の手順をご覧ください。対応していない場合もブラウザーで利用できます。",
  };
}
