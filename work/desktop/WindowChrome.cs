/*
 * [INPUT]: 接收窗口消息、DPI 变更及前端 WebView2 发送的 chrome 主题/栏目同步指令。
 * [OUTPUT]: 提供无边框现代自绘标题栏、DPI 自适应布局、窗口拖拽缩放与日夜色彩同步。
 * [POS]: WorkspaceWindow 的窗口框体分部类，与工作台瓷白/深空主题保持零色差衔接。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed partial class WorkspaceWindow
{
    private Color chromeBackground = Color.FromArgb(246, 247, 249);
    private Color chromeText = Color.FromArgb(17, 24, 39);
    private Color chromeAccent = Color.FromArgb(54, 92, 198);
    private Color chromeDivider = Color.FromArgb(228, 231, 236);
    private Panel chromePanel;
    private Button chromeNew;
    private Label chromeSection;
    private PictureBox chromeLogo;
    private Bitmap captionWordmarkLight;
    private Bitmap captionWordmarkDark;
    private Panel chromeAiBadge;
    private Button chromeAiStatus;
    private Action adaptChromeLayout;
    private Button maximizeButton;
    private const int StandardDpi = 96;
    private static readonly Size PreferredWorkspaceSize = new Size(1360, 900);
    private int chromeDpi = StandardDpi;
    private const int WmNcCalcSize = 0x0083;
    private const int WmNcHitTest = 0x0084;
    private const int WmGetMinMaxInfo = 0x0024;
    private const int WmNcPaint = 0x0085;
    private const int WmNcActivate = 0x0086;
    private const int WmDpiChanged = 0x02E0;
    private const uint MonitorDefaultToNearest = 0x00000002;
    private const int HtLeft = 10;
    private const int HtRight = 11;
    private const int HtTop = 12;
    private const int HtTopLeft = 13;
    private const int HtTopRight = 14;
    private const int HtBottom = 15;
    private const int HtBottomLeft = 16;
    private const int HtBottomRight = 17;

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    private static extern int AddFontResourceEx(string fileName, uint flags, IntPtr reserved);

    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public Point ptReserved;
        public Point ptMaxSize;
        public Point ptMaxPosition;
        public Point ptMinTrackSize;
        public Point ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int cbSize;
        public Rect rcMonitor;
        public Rect rcWork;
        public int dwFlags;
    }

    private static readonly string UiFontFamily = PickChromeFont();
    private static readonly Color CloseHover = Color.FromArgb(225, 29, 72);

    private static string PickChromeFont()
    {
        foreach (string name in new[] { "Microsoft YaHei UI", "Microsoft YaHei", "DengXian" })
        {
            try { using (var family = new FontFamily(name)) return family.Name; }
            catch (ArgumentException) { }
        }
        string fontFile = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "workspace", "NotoSansSC.ttf");
        const uint privateFont = 0x10;
        if (System.IO.File.Exists(fontFile) && AddFontResourceEx(fontFile, privateFont, IntPtr.Zero) > 0)
            return "Noto Sans SC";
        return SystemFonts.MessageBoxFont.FontFamily.Name;
    }

    private int ScaleChrome(int pixels)
    {
        return (int)Math.Round(pixels * chromeDpi / (double)StandardDpi);
    }

    private static Bitmap LoadCaptionWordmark(string name)
    {
        using (var stream = typeof(WorkspaceWindow).Assembly.GetManifestResourceStream(name))
        using (var image = Image.FromStream(stream))
            return new Bitmap(image);
    }

    private void SetWorkspaceWorkArea(Rectangle area, Rectangle recommended, bool center)
    {
        MinimumSize = new Size(Math.Min(ScaleChrome(400), area.Width), Math.Min(ScaleChrome(300), area.Height));
        if (WindowState != FormWindowState.Normal) return;
        var size = new Size(Math.Min(area.Width, Math.Max(MinimumSize.Width, recommended.Width)),
            Math.Min(area.Height, Math.Max(MinimumSize.Height, recommended.Height)));
        int left = center ? area.Left + (area.Width - size.Width) / 2 : Math.Max(area.Left, Math.Min(recommended.Left, area.Right - size.Width));
        int top = center ? area.Top + (area.Height - size.Height) / 2 : Math.Max(area.Top, Math.Min(recommended.Top, area.Bottom - size.Height));
        Bounds = new Rectangle(new Point(left, top), size);
    }

    protected override void OnLoad(EventArgs args)
    {
        chromeDpi = DeviceDpi;
        var area = Screen.FromHandle(Handle).WorkingArea;
        var size = new Size(ScaleChrome(PreferredWorkspaceSize.Width), ScaleChrome(PreferredWorkspaceSize.Height));
        SetWorkspaceWorkArea(area, new Rectangle(area.Location, size), true);
        if (adaptChromeLayout != null) adaptChromeLayout();
        base.OnLoad(args);
    }

    private void InstallWindowChrome()
    {
        FormBorderStyle = FormBorderStyle.None;
        // Match the caption background during maximize, restore and redraw.
        BackColor = chromeBackground;

        var titleBar = chromePanel = new Panel { Dock = DockStyle.Top, Height = 42, BackColor = chromeBackground };
        titleBar.Paint += (sender, args) =>
        {
            int lineHeight = titleBar.Padding.Bottom;
            using (var ink = new SolidBrush(chromeDivider))
                args.Graphics.FillRectangle(ink, 0, titleBar.Height - lineHeight, titleBar.Width, lineHeight);
        };
        var close = CaptionButton("", "关闭", Close, true);
        maximizeButton = CaptionButton("", "最大化", ToggleMaximize, false);
        var minimize = CaptionButton("", "最小化", delegate { WindowState = FormWindowState.Minimized; }, false);
        close.Paint += (sender, args) => DrawCaptionIcon(close, args.Graphics);
        maximizeButton.Paint += (sender, args) => DrawCaptionIcon(maximizeButton, args.Graphics);
        minimize.Paint += (sender, args) => DrawCaptionIcon(minimize, args.Graphics);
        captionWordmarkLight = LoadCaptionWordmark("DoNote.CaptionWordmark.png");
        captionWordmarkDark = LoadCaptionWordmark("DoNote.CaptionWordmark.Dark.png");
        var brand = new Panel { Dock = DockStyle.Left, BackColor = Color.Transparent };
        var logo = chromeLogo = new PictureBox
        {
            Dock = DockStyle.Fill, BackColor = Color.Transparent, Image = captionWordmarkLight,
            SizeMode = PictureBoxSizeMode.Zoom, AccessibleName = "DoNote"
        };
        brand.Controls.Add(logo);
        logo.Disposed += (sender, args) => { captionWordmarkLight.Dispose(); captionWordmarkDark.Dispose(); };
        chromeSection = new Label { Text = "总览", TextAlign = ContentAlignment.MiddleCenter, AutoEllipsis = true };
        var settings = CaptionButton("设置", "设置", async delegate { await InvokeWorkspaceControl("desktopSettingsButton"); }, false);
        settings.Dock = DockStyle.Left;
        settings.Width = 62;
        chromeNew = CaptionButton("＋ 新建记录", "新建记录", async delegate { await InvokeWorkspaceControl("newBtn"); }, false);
        chromeNew.Dock = DockStyle.Left;
        chromeAiBadge = new Panel { Dock = DockStyle.Left, Width = 42, BackColor = chromeBackground, Visible = false };
        chromeAiStatus = CaptionButton("AI", "AI 已连接，打开 AI 管理", async delegate { await InvokeWorkspaceControl("openAiManager"); }, false);
        chromeAiStatus.Dock = DockStyle.None;
        chromeAiStatus.Paint += (sender, args) =>
        {
            int dotSize = ScaleChrome(4);
            using (var ink = new SolidBrush(chromeAccent))
                args.Graphics.FillEllipse(ink, chromeAiStatus.Width - ScaleChrome(7), ScaleChrome(4), dotSize, dotSize);
        };
        chromeAiBadge.Controls.Add(chromeAiStatus);
        var hint = new ToolTip();
        hint.SetToolTip(chromeAiStatus, "AI 已连接 · 打开 AI 管理");
        hint.SetToolTip(chromeNew, "新建记录 (Ctrl+N)");
        titleBar.Disposed += (sender, args) => hint.Dispose();
        titleBar.Controls.AddRange(new Control[] { chromeSection, chromeAiBadge, chromeNew, settings, brand, minimize, maximizeButton, close });
        Font commandFont = null, sectionFont = null;
        int layoutDpi = 0;
        titleBar.Disposed += (sender, args) =>
        {
            if (commandFont != null) commandFont.Dispose();
            if (sectionFont != null) sectionFont.Dispose();
        };
        Action adaptChrome = delegate
        {
            titleBar.SuspendLayout();
            try
            {
                if (layoutDpi != chromeDpi)
                {
                    layoutDpi = chromeDpi;
                    var oldCommand = commandFont;
                    var oldSection = sectionFont;
                    commandFont = new Font(UiFontFamily, ScaleChrome(13), FontStyle.Regular, GraphicsUnit.Pixel);
                    sectionFont = new Font(UiFontFamily, ScaleChrome(14), FontStyle.Bold, GraphicsUnit.Pixel);
                    settings.Font = chromeNew.Font = chromeAiStatus.Font = commandFont;
                    chromeSection.Font = sectionFont;
                    if (oldCommand != null) oldCommand.Dispose();
                    if (oldSection != null) oldSection.Dispose();
                    brand.Padding = new Padding(ScaleChrome(10), ScaleChrome(7), ScaleChrome(10), ScaleChrome(7));
                    chromeAiBadge.Width = ScaleChrome(42);
                    chromeAiStatus.SetBounds(ScaleChrome(4), ScaleChrome(6), ScaleChrome(34), ScaleChrome(28));
                    titleBar.Padding = new Padding(0, 0, 0, ScaleChrome(1));
                    titleBar.Height = ScaleChrome(42);
                }
                int available = titleBar.ClientSize.Width;
                bool compact = available < ScaleChrome(700);
                brand.Width = ScaleChrome(compact ? 88 : 100);
                settings.Width = Math.Max(ScaleChrome(56), TextRenderer.MeasureText(settings.Text, commandFont).Width + ScaleChrome(16));
                chromeNew.Text = compact ? "+" : "+ 新建记录";
                chromeNew.Width = compact ? ScaleChrome(38) : TextRenderer.MeasureText(chromeNew.Text, commandFont).Width + ScaleChrome(26);
                foreach (var button in new[] { minimize, maximizeButton, close }) button.Width = ScaleChrome(compact ? 34 : 46);
                int leftWidth = brand.Width + settings.Width + chromeNew.Width + (chromeAiBadge.Visible ? chromeAiBadge.Width : 0);
                int rightWidth = minimize.Width + maximizeButton.Width + close.Width;
                int margin = ScaleChrome(6);
                int width = Math.Min(ScaleChrome(260), Math.Max(0, available - leftWidth - rightWidth - margin * 2));
                int left = Math.Max(leftWidth + margin, Math.Min((available - width) / 2, available - rightWidth - margin - width));
                chromeSection.SetBounds(left, 0, width, titleBar.DisplayRectangle.Height);
            }
            finally { titleBar.ResumeLayout(); }
        };
        adaptChromeLayout = adaptChrome;
        titleBar.SizeChanged += (sender, args) => adaptChrome();
        Controls.Add(titleBar);
        adaptChrome();
        ApplyChromeState(false, "总览");

        foreach (Control dragTarget in new Control[] { titleBar, brand, logo, chromeSection })
        {
            dragTarget.MouseDown += (sender, args) =>
            {
                if (args.Button != MouseButtons.Left || args.Clicks != 1) return;
                ReleaseCapture();
                SendMessage(Handle, 0x00A1, (IntPtr)2, IntPtr.Zero);
            };
            dragTarget.MouseDoubleClick += (sender, args) => { if (args.Button == MouseButtons.Left) ToggleMaximize(); };
        }
        Resize += (sender, args) =>
        {
            bool maximized = WindowState == FormWindowState.Maximized;

            maximizeButton.AccessibleName = maximized ? "还原" : "最大化";
            maximizeButton.Invalidate();
        };
    }

    private void DrawCaptionIcon(Button button, Graphics graphics)
    {
        var state = graphics.Save();
        try
        {
            graphics.TranslateTransform(button.ClientSize.Width / 2f, button.ClientSize.Height / 2f);
            graphics.ScaleTransform(chromeDpi / (float)StandardDpi, chromeDpi / (float)StandardDpi);
            using (var pen = new Pen(button.ForeColor))
            {
                if (button.AccessibleName == "关闭")
                {
                    graphics.DrawLine(pen, -5, -5, 5, 5);
                    graphics.DrawLine(pen, -5, 5, 5, -5);
                }
                else if (button == maximizeButton)
                {
                    if (WindowState == FormWindowState.Maximized)
                    {
                        var back = new[] { new Point(-2, -5), new Point(5, -5), new Point(5, 2), new Point(3, 2) };
                        graphics.DrawLines(pen, back);
                        graphics.DrawRectangle(pen, -5, -2, 8, 7);
                    }
                    else graphics.DrawRectangle(pen, -5, -5, 10, 10);
                }
                else graphics.DrawLine(pen, -5, 2, 5, 2);
            }
        }
        finally { graphics.Restore(state); }
    }

    private Button CaptionButton(string label, string name, Action action, bool isClose)
    {
        var button = new Button
        {
            Dock = DockStyle.Right, Width = 46, Text = label, AccessibleName = name, FlatStyle = FlatStyle.Flat,
            BackColor = chromeBackground, ForeColor = Color.FromArgb(45, 45, 45), UseVisualStyleBackColor = false
        };
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = isClose ? CloseHover : Color.FromArgb(228, 228, 228);
        if (isClose)
        {
            button.MouseEnter += (sender, args) => { button.ForeColor = Color.White; };
            button.MouseLeave += (sender, args) => { button.ForeColor = chromeText; };
        }
        button.Click += (sender, args) => action();
        return button;
    }

    private void ToggleMaximize()
    {
        if (WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
        else WindowState = FormWindowState.Maximized;
        // Force a full repaint so a strip left over from the previous geometry
        // cannot linger along the top edge.
        Invalidate(true);
        Update();
    }

    private void ApplyMaximizedBounds(Message message)
    {
        base.WndProc(ref message);
        var info = (MinMaxInfo)Marshal.PtrToStructure(message.LParam, typeof(MinMaxInfo));
        IntPtr monitor = MonitorFromWindow(Handle, MonitorDefaultToNearest);
        if (monitor != IntPtr.Zero)
        {
            var monitorInfo = new MonitorInfo { cbSize = Marshal.SizeOf(typeof(MonitorInfo)) };
            if (GetMonitorInfo(monitor, ref monitorInfo))
            {
                info.ptMaxPosition = new Point(
                    monitorInfo.rcWork.Left - monitorInfo.rcMonitor.Left,
                    monitorInfo.rcWork.Top - monitorInfo.rcMonitor.Top);
                info.ptMaxSize = new Point(
                    monitorInfo.rcWork.Right - monitorInfo.rcWork.Left,
                    monitorInfo.rcWork.Bottom - monitorInfo.rcWork.Top);
            }
        }
        Marshal.StructureToPtr(info, message.LParam, true);
        message.Result = IntPtr.Zero;
    }

    protected override void WndProc(ref Message message)
    {
        // WS_THICKFRAME keeps native resize and snap behavior, but its invisible
        // border must not inset the visible client area when the window is maximized.
        if (message.Msg == WmNcCalcSize)
        {
            // Strip the non-client area for both cases so the client covers the
            // whole window. Combined with WM_GETMINMAXINFO this keeps the client
            // flush against the working area when maximized.
            message.Result = IntPtr.Zero;
            return;
        }
        if (message.Msg == WmGetMinMaxInfo)
        {
            ApplyMaximizedBounds(message);
            return;
        }
        // A borderless window must not let Windows paint a non-client frame; leaving
        // that to the default handler can leave a grey strip above the caption.
        if (message.Msg == WmNcPaint)
        {
            message.Result = IntPtr.Zero;
            return;
        }
        if (message.Msg == WmNcActivate)
        {
            message.Result = (IntPtr)1;
            return;
        }
        // Moving between monitors with different scaling can leave the top rows stale.
        if (message.Msg == WmDpiChanged)
        {
            chromeDpi = (int)(message.WParam.ToInt64() & 0xffff);
            var rect = (Rect)Marshal.PtrToStructure(message.LParam, typeof(Rect));
            var recommended = Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
            base.WndProc(ref message);
            SetWorkspaceWorkArea(Screen.FromRectangle(recommended).WorkingArea, recommended, false);
            if (adaptChromeLayout != null) adaptChromeLayout();
            Invalidate(true);
            Update();
            return;
        }
        if (message.Msg == WmNcHitTest && WindowState == FormWindowState.Normal)
        {
            base.WndProc(ref message);
            Point screenPoint = new Point(unchecked((short)((long)message.LParam & 0xffff)),
                unchecked((short)(((long)message.LParam >> 16) & 0xffff)));
            Point clientPoint = PointToClient(screenPoint);
            int grip = ScaleChrome(6);
            bool left = clientPoint.X >= 0 && clientPoint.X < grip;
            bool right = clientPoint.X < ClientSize.Width && clientPoint.X >= ClientSize.Width - grip;
            bool top = clientPoint.Y >= 0 && clientPoint.Y < grip;
            bool bottom = clientPoint.Y < ClientSize.Height && clientPoint.Y >= ClientSize.Height - grip;
            if (left && top) message.Result = (IntPtr)HtTopLeft;
            else if (right && top) message.Result = (IntPtr)HtTopRight;
            else if (left && bottom) message.Result = (IntPtr)HtBottomLeft;
            else if (right && bottom) message.Result = (IntPtr)HtBottomRight;
            else if (left) message.Result = (IntPtr)HtLeft;
            else if (right) message.Result = (IntPtr)HtRight;
            else if (top) message.Result = (IntPtr)HtTop;
            else if (bottom) message.Result = (IntPtr)HtBottom;
            return;
        }
        base.WndProc(ref message);
    }

    private bool TryApplyChromeMessage(string command)
    {
        if (command == "ai-indicator:on" || command == "ai-indicator:off")
        {
            SetAiConnectionIndicator(command == "ai-indicator:on");
            return true;
        }
        const string prefix = "chrome:";
        if (command == null || !command.StartsWith(prefix, StringComparison.Ordinal)) return false;
        string[] parts = command.Split(new[] { ':' }, 4);
        if (parts.Length >= 3 && (parts[1] == "dark" || parts[1] == "light") && parts[2].Length <= 1500)
        {
            string section = Uri.UnescapeDataString(parts[2]);
            Color? background = null;
            if (parts.Length == 4 && parts[3].Length == 7 && parts[3][0] == '#')
            {
                int rgb;
                if (int.TryParse(parts[3].Substring(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out rgb))
                    background = Color.FromArgb((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
            }
            if (!string.IsNullOrWhiteSpace(section) && section.Length <= 160)
                ApplyChromeState(parts[1] == "dark", section, background);
        }
        return true;
    }

    private void SetAiConnectionIndicator(bool connected)
    {
        if (chromeAiBadge == null) return;
        chromeAiBadge.Visible = connected;
        if (adaptChromeLayout != null) adaptChromeLayout();
    }

    private void ApplyChromeState(bool dark, string section, Color? background = null)
    {
        if (chromePanel == null) return;
        chromeBackground = background ?? (dark ? Color.FromArgb(11, 17, 32) : Color.FromArgb(244, 247, 251));
        chromeText = dark ? Color.FromArgb(241, 245, 249) : Color.FromArgb(15, 23, 42);
        chromeAccent = dark ? Color.FromArgb(96, 165, 250) : Color.FromArgb(37, 99, 235);
        chromeDivider = MixChromeColor(chromeBackground, chromeText, dark ? 14 : 10);
        Color hover = MixChromeColor(chromeBackground, chromeText, 8);
        Color pressed = MixChromeColor(chromeBackground, chromeText, 14);
        BackColor = chromeBackground;
        chromePanel.BackColor = chromeBackground;
        if (chromeLogo != null) chromeLogo.Image = dark ? captionWordmarkDark : captionWordmarkLight;
        if (chromeAiBadge != null) chromeAiBadge.BackColor = chromeBackground;
        foreach (Control control in chromePanel.Controls)
        {
            control.ForeColor = chromeText;
            var button = control as Button;
            if (button != null)
            {
                button.BackColor = chromeBackground;
                button.FlatAppearance.MouseOverBackColor = control.AccessibleName == "关闭"
                    ? CloseHover : hover;
                button.FlatAppearance.MouseDownBackColor = control.AccessibleName == "关闭"
                    ? Color.FromArgb(145, 39, 32) : pressed;
            }
        }
        chromeSection.Text = section;
        chromeNew.ForeColor = chromeAccent;
        chromeNew.FlatAppearance.MouseOverBackColor = MixChromeColor(chromeBackground, chromeAccent, 12);
        chromeNew.FlatAppearance.MouseDownBackColor = MixChromeColor(chromeBackground, chromeAccent, 19);
        chromeAiStatus.BackColor = chromeBackground;
        chromeAiStatus.ForeColor = chromeText;
        chromeAiStatus.FlatAppearance.MouseOverBackColor = hover;
        chromeAiStatus.FlatAppearance.MouseDownBackColor = pressed;
        chromePanel.Invalidate();
    }

    private static Color MixChromeColor(Color background, Color foreground, int amount)
    {
        int baseAmount = 100 - amount;
        return Color.FromArgb(
            (background.R * baseAmount + foreground.R * amount) / 100,
            (background.G * baseAmount + foreground.G * amount) / 100,
            (background.B * baseAmount + foreground.B * amount) / 100);
    }

    private Task InvokeWorkspaceControl(string id)
    {
        browser.Focus();
        if (id == "desktopSettingsButton")
            return RunMenuScript("document.getElementById('desktopSettingsButton')?.click()");
        return RunMenuScript("(function(){var button=document.getElementById('" + id + "');if(button&&!button.disabled&&!document.querySelector('dialog[open]'))button.click()})()");
    }

    private async Task RunMenuScript(string script)
    {
        try { if (browser.CoreWebView2 != null) await browser.CoreWebView2.ExecuteScriptAsync(script); }
        catch (InvalidOperationException) { }
        catch (COMException) { }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            const int sizableFrame = 0x00040000;
            const int systemMenu = 0x00080000;
            const int minimizeBox = 0x00020000;
            const int maximizeBox = 0x00010000;
            parameters.Style |= sizableFrame | systemMenu | minimizeBox | maximizeBox;
            return parameters;
        }
    }
}
