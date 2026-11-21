using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// テスト専用EXE。本人のブラウザーや保存済み認証は使わない。
public static class DesktopTests
{
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr handle, int index);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr handle, uint command);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    static int count;
    static void Check(bool value, string message) { if (!value) throw new Exception(message); count++; Console.WriteLine("PASS " + message); }
    [STAThread]
    public static int Main()
    {
        try {
            Check(Dashboard.AllowedNavigation(Dashboard.Home), "production URL allowed");
            Check(Dashboard.AllowedNavigation("https://github.com/login/oauth/authorize"), "GitHub login allowed");
            foreach (string uri in new [] { "http://personal-dashboard.kait0.workers.dev", "file:///C:/secret", "javascript:alert(1)", "https://personal-dashboard.kait0.workers.dev.evil.test/", "https://user@github.com/", "https://github.com:444/" })
                Check(!Dashboard.AllowedNavigation(uri), "unsafe or out-of-scope URL rejected");
            var fit = BackgroundWindow.FitBounds(new Rectangle(2000, 1000, 1500, 900), new Rectangle(-1280, 0, 1280, 720));
            Check(fit == new Rectangle(-1280, 0, 1280, 720), "disconnected monitor bounds fit remaining monitor");
            Application.EnableVisualStyles();
            using (var dashboard = new BackgroundWindow()) using (var other = new Form()) {
                dashboard.Text = "Dashboard placement test"; other.Text = "Other application fixture";
                dashboard.Show(); other.Show(); other.Activate(); Application.DoEvents();
                var before = dashboard.Bounds; var foreground = GetForegroundWindow();
                dashboard.SetBackgroundMode(true); Application.DoEvents();
                Check(dashboard.BackgroundMode && dashboard.FormBorderStyle == FormBorderStyle.None, "background mode is borderless");
                Check(dashboard.Bounds == Screen.FromControl(dashboard).WorkingArea, "background respects taskbar working area");
                Check((GetWindowLong(dashboard.Handle, -20) & 8) == 0, "background is not WS_EX_TOPMOST");
                Check(GetForegroundWindow() == foreground, "entering background does not steal focus");
                bool behind = false;
                for (var window = GetWindow(other.Handle, 2); window != IntPtr.Zero; window = GetWindow(window, 2))
                    if (window == dashboard.Handle) { behind = true; break; }
                Check(behind, "dashboard is behind other application window");
                dashboard.Activate(); Application.DoEvents();
                other.Activate(); Application.DoEvents();
                Check(GetForegroundWindow() == other.Handle, "switching away keeps other application active");
                behind = false;
                for (var window = GetWindow(other.Handle, 2); window != IntPtr.Zero; window = GetWindow(window, 2))
                    if (window == dashboard.Handle) { behind = true; break; }
                Check(behind, "switching away returns dashboard behind other application");
                dashboard.SetBackgroundMode(false); Application.DoEvents();
                Check(!dashboard.BackgroundMode && dashboard.FormBorderStyle == FormBorderStyle.Sizable, "normal window restored");
                Check(dashboard.Bounds == BackgroundWindow.FitBounds(before, Screen.FromRectangle(before).WorkingArea), "normal bounds restored");
                Check((GetWindowLong(dashboard.Handle, -20) & 8) == 0, "normal window is not topmost");
                dashboard.SetBackgroundMode(true); dashboard.Close(); other.Close();
                Check(dashboard.IsDisposed, "background window can exit");
            }
            Console.WriteLine("PASS total=" + count); return 0;
        } catch (Exception error) { Console.Error.WriteLine("FAIL " + error.Message); return 1; }
    }
}
