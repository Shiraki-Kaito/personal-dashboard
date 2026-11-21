using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

public sealed class Dashboard : BackgroundWindow
{
    public const string Home = "https://personal-dashboard.kait0.workers.dev/";
    readonly WebView2 web = new WebView2();
    readonly ToolStripLabel status = new ToolStripLabel("読み込み中…");
    readonly ToolStripButton mode = new ToolStripButton("背景表示");
    readonly ToolStripButton retry = new ToolStripButton("再読込");
    readonly NotifyIcon tray = new NotifyIcon();
    readonly bool startInBackground;

    public Dashboard(bool background)
    {
        startInBackground = background;
        AutoScaleMode = AutoScaleMode.Dpi;
        var toolbar = new ToolStrip { GripStyle = ToolStripGripStyle.Hidden, Dock = DockStyle.Top };
        var normal = new ToolStripButton("通常表示");
        var browser = new ToolStripButton("ブラウザーで開く");
        var close = new ToolStripButton("終了");
        toolbar.Items.AddRange(new ToolStripItem[] { mode, normal, retry, browser, close, status });
        web.Dock = DockStyle.Fill;
        Controls.Add(web); Controls.Add(toolbar);
        mode.Click += delegate { SetBackgroundMode(true); };
        normal.Click += delegate { SetBackgroundMode(false); Show(); Activate(); };
        close.Click += delegate { Close(); };
        browser.Click += delegate { OpenExternal(Home); };
        retry.Click += delegate { if (web.CoreWebView2 != null) web.CoreWebView2.Navigate(Home); };
        ModeChanged += delegate { UpdateMode(); };
        BackgroundPlacementFailed += delegate { status.Text = "背面へ移動できませんでした。通常表示で再試行してください。"; };
        var menu = new ContextMenuStrip();
        menu.Items.Add("通常表示へ戻す", null, delegate { SetBackgroundMode(false); Show(); Activate(); });
        menu.Items.Add("背景表示", null, delegate { Show(); SetBackgroundMode(true); });
        menu.Items.Add("終了", null, delegate { Close(); });
        tray.Icon = SystemIcons.Application;
        tray.Text = "Personal Dashboard";
        tray.ContextMenuStrip = menu; tray.Visible = true;
        tray.DoubleClick += delegate { SetBackgroundMode(false); Show(); Activate(); };
        Shown += Initialize;
        FormClosed += delegate { tray.Visible = false; tray.Dispose(); web.Dispose(); };
    }

    void UpdateMode()
    {
        mode.Enabled = !BackgroundMode;
        status.Text = BackgroundMode ? "背景表示・他アプリへ切り替えると背面へ" : "通常表示";
    }

    async void Initialize(object sender, EventArgs args)
    {
        try {
            string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PersonalDashboard", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            if (IsDisposed || Disposing) return;
            await web.EnsureCoreWebView2Async(environment);
            if (IsDisposed || Disposing) return;
            web.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            web.CoreWebView2.Settings.IsWebMessageEnabled = false;
            web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            web.CoreWebView2.Settings.IsPasswordAutosaveEnabled = false;
            web.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
            web.CoreWebView2.PermissionRequested += delegate(object s, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
            web.CoreWebView2.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e) {
                if (!AllowedNavigation(e.Uri)) { e.Cancel = true; status.Text = "外部リンクは通常のブラウザーから開いてください。"; }
            };
            web.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e) {
                e.Handled = true;
                if (e.IsUserInitiated) OpenExternal(e.Uri);
            };
            web.CoreWebView2.DownloadStarting += delegate(object s, CoreWebView2DownloadStartingEventArgs e) {
                e.Cancel = true; status.Text = "ダウンロードは「ブラウザーで開く」から行ってください。";
            };
            web.CoreWebView2.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs e) {
                if (!e.IsSuccess) status.Text = "表示に失敗しました。接続を確認し「再読込」を押してください。";
                else UpdateMode();
            };
            web.CoreWebView2.ProcessFailed += delegate { status.Text = "表示エンジンが停止しました。このアプリを終了して開き直してください。"; };
            web.CoreWebView2.Navigate(Home);
            if (startInBackground) SetBackgroundMode(true);
        } catch (Exception) {
            if (IsDisposed || Disposing) return;
            status.Text = "WebView2を起動できません。Runtimeと書き込み権限を確認してアプリを開き直してください。";
            retry.Enabled = false;
        }
    }

    public static bool AllowedNavigation(string value)
    {
        Uri uri;
        return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.IsDefaultPort && uri.UserInfo == "" &&
            (uri.Host == "personal-dashboard.kait0.workers.dev" || uri.Host == "github.com");
    }

    void OpenExternal(string value)
    {
        Uri uri;
        if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.Scheme != "https" || uri.UserInfo != "") return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception) { status.Text = "既定のブラウザーを開けませんでした。"; }
    }

    [STAThread]
    public static void Main(string[] args)
    {
        bool created;
        using (var mutex = new Mutex(true, "Local\\PersonalDashboard.Desktop", out created)) {
            if (!created) { MessageBox.Show("既に起動しています。通知領域のPersonal Dashboardから通常表示へ戻せます。"); return; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Dashboard(Array.IndexOf(args, "--background") >= 0));
        }
    }
}
