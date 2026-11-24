using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// 背景モードの配置だけを担当する。Explorerの内部ウィンドウには触れない。
public class BackgroundWindow : Form
{
    const uint NoSize = 0x0001, NoMove = 0x0002, NoActivate = 0x0010;
    static readonly IntPtr BottomWindow = new IntPtr(1);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
    Rectangle normalBounds;
    bool changing;
    bool placementQueued;
    const int DisplayChangedMessage = 0x007E, SettingsChangedMessage = 0x001A;
    protected override bool ShowWithoutActivation { get { return changing || base.ShowWithoutActivation; } }
    public bool BackgroundMode { get; private set; }
    public event EventHandler ModeChanged;
    public event EventHandler BackgroundPlacementFailed;

    public BackgroundWindow()
    {
        Text = "Personal Dashboard — Windows";
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1100, 760);
        MinimumSize = new Size(420, 300);
        TopMost = false;
        KeyPreview = true;
        Deactivate += delegate { if (BackgroundMode && !changing) SendBehind(); };
        KeyDown += delegate(object sender, KeyEventArgs e) {
            if (e.Control && e.Alt && e.KeyCode == Keys.B) { SetBackgroundMode(!BackgroundMode); e.Handled = true; }
        };
    }

    public void RestoreNormalWindow()
    {
        SetBackgroundMode(false);
        // モードが既に通常でも、最小化状態からは明示的に復元する。
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        RefreshDisplayPlacement();
        Show();
        Activate();
    }

    public void ShowBackgroundWindow()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        if (BackgroundMode) RefreshDisplayPlacement();
        else SetBackgroundMode(true);
    }

    public void SetBackgroundMode(bool enabled)
    {
        if (enabled == BackgroundMode) return;
        IntPtr previousForeground = GetForegroundWindow();
        bool anotherWindowActive = previousForeground != IntPtr.Zero && previousForeground != Handle;
        changing = true;
        try {
            if (enabled) {
                normalBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                WindowState = FormWindowState.Normal;
                TopMost = false;
                FormBorderStyle = FormBorderStyle.None;
                Bounds = Screen.FromControl(this).WorkingArea;
                BackgroundMode = true;
                SendBehind();
                // WinFormsが枠の変更時に再生成したウィンドウへ移したフォーカスだけを戻す。
                if (anotherWindowActive && GetForegroundWindow() == Handle)
                    SetForegroundWindow(previousForeground);
            } else {
                BackgroundMode = false;
                WindowState = FormWindowState.Normal;
                FormBorderStyle = FormBorderStyle.Sizable;
                Rectangle area = Screen.FromRectangle(normalBounds).WorkingArea;
                Bounds = FitBounds(normalBounds, area);
                TopMost = false;
            }
        } finally { changing = false; }
        if (ModeChanged != null) ModeChanged(this, EventArgs.Empty);
    }

    public static Rectangle FitBounds(Rectangle saved, Rectangle area)
    {
        int width = Math.Min(saved.Width, area.Width), height = Math.Min(saved.Height, area.Height);
        return new Rectangle(Math.Max(area.Left, Math.Min(saved.Left, area.Right - width)),
            Math.Max(area.Top, Math.Min(saved.Top, area.Bottom - height)), width, height);
    }

    // 通知処理後にScreenの情報を読み直す。連続する通知は1回にまとめる。
    protected override void WndProc(ref Message message)
    {
        int kind = message.Msg;
        base.WndProc(ref message);
        if ((kind != DisplayChangedMessage && kind != SettingsChangedMessage) ||
            placementQueued || !IsHandleCreated || IsDisposed || Disposing) return;
        placementQueued = true;
        BeginInvoke((MethodInvoker)delegate {
            placementQueued = false;
            if (!IsDisposed && !Disposing) RefreshDisplayPlacement();
        });
    }

    protected virtual Rectangle WorkingAreaFor(Rectangle bounds)
    {
        return Screen.FromRectangle(bounds).WorkingArea;
    }

    public void RefreshDisplayPlacement()
    {
        if (changing || !IsHandleCreated || IsDisposed || Disposing) return;
        // 最小化中は表示を復帰させない。通常表示への復帰時にも範囲を照合する。
        if (WindowState == FormWindowState.Minimized) return;
        changing = true;
        try {
            if (BackgroundMode) {
                normalBounds = FitBounds(normalBounds, WorkingAreaFor(normalBounds));
                Rectangle area = WorkingAreaFor(Bounds);
                // TopMostの再設定は前面化を招く。非アクティブの配置APIだけを使う。
                if (!SetWindowPos(Handle, BottomWindow, area.X, area.Y, area.Width, area.Height, NoActivate))
                    PlacementFailed();
            } else if (WindowState == FormWindowState.Normal) {
                Bounds = FitBounds(Bounds, WorkingAreaFor(Bounds));
            }
        } finally { changing = false; }
    }

    void SendBehind()
    {
        if (!IsHandleCreated || IsDisposed) return;
        if (!SetWindowPos(Handle, BottomWindow, 0, 0, 0, 0, NoSize | NoMove | NoActivate)) {
            PlacementFailed();
        }
    }

    void PlacementFailed()
    {
        // 一定周期で繰り返してフォーカスを奪うことはしない。
        BackgroundMode = false;
        FormBorderStyle = FormBorderStyle.Sizable;
        if (BackgroundPlacementFailed != null) BackgroundPlacementFailed(this, EventArgs.Empty);
    }
}
