/**
 * [INPUT]: 接收 WebView2 工作台消息和本机资料目录设置。
 * [OUTPUT]: 提供桌面窗口、工作台宿主和本机服务入口。
 * [POS]: 约束开屏动画对原生标题栏的占用时间，并保留窗口退出和资料访问入口。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool first;
        using (var instance = new Mutex(true, "Local\\YamsOne.Desktop", out first))
        {
            if (first) Application.Run(new WorkspaceWindow());
            else MessageBox.Show("DoNote 已经打开。", "DoNote");
        }
    }
}

internal sealed partial class WorkspaceWindow : Form
{
    private const string WorkspaceHost = "yams-one.example";
    private const string WorkspaceUrl = "https://" + WorkspaceHost + "/index.html";
    private const string BridgeReadyPrefix = "YAMS_ONE_BRIDGE_READY ";
    private const int StartupSplashDeadlineMilliseconds = 3000;
    private readonly WebView2 browser = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(246, 246, 246) };
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 65536 };
    private readonly string defaultDataRoot = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Data");
    private readonly string locationFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data-location.txt");
    private string dataRoot;
    private Process bridgeProcess;
    private Process captureProcess;
    private BridgeConnection bridgeConnection;
    private bool bridgeStarting;
    private bool exitConfirmed;
    private bool startupHandled;
    private bool splashEnabled;
    private bool startupSplashPending;
    private System.Windows.Forms.Timer startupSplashDeadline;
    private bool pdfInvertEnabled;

    public WorkspaceWindow()
    {
        Text = "DoNote";
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = PreferredWorkspaceSize;
        Controls.Add(browser);
        InstallWindowChrome();
        Shown += OpenWorkspace;
        FormClosing += ConfirmExit;
        Disposed += (sender, args) => EndStartupSplash();
        FormClosed += (sender, args) =>
        {
            StopLocalBridge();
            StopWebCapture();
            StopVideoTranscription();
            StopLocalSubtitleTranslation();
            StopLocalLlmTranslation();
            StopBilingualPairProcesses();
            StopNativeBackup(false);
            StopMinerUReflow();
            StopPdf2zh();
        };
    }

    private string SplashPreferencePath { get { return Path.Combine(dataRoot, "startup-animation.disabled"); } }

    private void OfferStartupSplash(CoreWebView2 web)
    {
        startupSplashPending = true;
        startupSplashDeadline = new System.Windows.Forms.Timer { Interval = StartupSplashDeadlineMilliseconds };
        startupSplashDeadline.Tick += (sender, args) => EndStartupSplash();
        startupSplashDeadline.Start();
        PostWorkspaceMessage(web, new { type = "yams-one-startup" });
    }

    private void EndStartupSplash()
    {
        if (startupSplashDeadline == null) return;
        startupSplashPending = false;
        startupSplashDeadline.Dispose();
        startupSplashDeadline = null;
        if (!IsDisposed && !Disposing) chromePanel.Show();
    }

    private string PdfInvertPreferencePath { get { return Path.Combine(dataRoot, "pdf-invert.enabled"); } }

    private void TogglePdfInvert(CoreWebView2 web)
    {
        try
        {
            if (pdfInvertEnabled)
                File.Delete(PdfInvertPreferencePath);
            else
                File.WriteAllText(PdfInvertPreferencePath, "enabled");
            pdfInvertEnabled = !pdfInvertEnabled;
        }
        catch (Exception error)
        {
            MessageBox.Show(this, "无法保存 PDF 反色设置。\n\n" + error.Message, Text);
        }
        SendPreferences(web);
    }

    private void ToggleSplash(CoreWebView2 web)
    {
        try
        {
            if (splashEnabled)
                File.WriteAllText(SplashPreferencePath, "disabled");
            else
                File.Delete(SplashPreferencePath);
            splashEnabled = !splashEnabled;
        }
        catch (Exception error)
        {
            MessageBox.Show(this, "无法保存开场动画设置。\n\n" + error.Message, Text);
        }
        SendPreferences(web);
    }

    private void SendPreferences(CoreWebView2 web)
    {
        PostWorkspaceMessage(web, new { type = "yams-one-preferences", splashEnabled, pdfInvert = pdfInvertEnabled });
    }

    private void ConfirmExit(object sender, FormClosingEventArgs args)
    {
        if (exitConfirmed || args.CloseReason != CloseReason.UserClosing) return;
        args.Cancel = MessageBox.Show(
            this,
            "请先保存正在编辑的记录。退出后，软件窗口和由它启动的本机 AI 服务都会关闭。",
            "确认完全退出 DoNote？",
            MessageBoxButtons.OKCancel,
            MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button2) != DialogResult.OK;
    }

    private void CloseWithoutExitPrompt()
    {
        exitConfirmed = true;
        Close();
    }

    private string LoadDataFolder()
    {
        string overridePath = Environment.GetEnvironmentVariable("YAMS_ONE_DESKTOP_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(overridePath)) return Path.GetFullPath(overridePath);
        string previous = File.Exists(locationFile) ? File.ReadAllText(locationFile).Trim() : defaultDataRoot;
        string pending = locationFile + ".pending";
        string legacy = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YamsOne");
        if (!File.Exists(pending))
        {
            // A deliberately fresh release must not silently re-import an old workspace.
            if (!File.Exists(locationFile) && !Directory.Exists(previous) && Directory.Exists(legacy)
                && !File.Exists(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fresh-start.marker")))
                CopyDataFolder(legacy, previous);
            return previous;
        }
        string destination = File.ReadAllText(pending).Trim();
        try
        {
            if (Directory.Exists(previous)) CopyDataFolder(previous, destination);
            else Directory.CreateDirectory(destination);
            string temporary = locationFile + ".new";
            File.WriteAllText(temporary, destination);
            if (File.Exists(locationFile)) File.Replace(temporary, locationFile, null);
            else File.Move(temporary, locationFile);
        }
        catch (Exception error)
        {
            File.Delete(pending);
            MessageBox.Show("无法迁移资料，将继续使用原目录。\n\n" + error.Message, Text);
            return previous;
        }
        File.Delete(pending);
        return destination;
    }

    private static void CopyDataFolder(string source, string destination)
    {
        if (Directory.Exists(destination) && Directory.GetFileSystemEntries(destination).Length > 0)
            throw new IOException("目标资料目录必须为空。");
        string parent = Path.GetDirectoryName(Path.GetFullPath(destination));
        string staging = Path.Combine(parent, ".ym-" + Guid.NewGuid().ToString("N").Substring(0, 10));
        try
        {
            CopyDirectory(source, staging);
            if (Directory.Exists(destination)) Directory.Delete(destination);
            Directory.Move(staging, destination);
        }
        finally
        {
            if (Path.GetDirectoryName(Path.GetFullPath(staging)) == parent && Directory.Exists(staging))
                Directory.Delete(staging, true);
        }
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (string file in Directory.GetFiles(source))
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) == 0)
                File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        foreach (string folder in Directory.GetDirectories(source))
        {
            if ((File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0) continue;
            string name = Path.GetFileName(folder);
            if (name.EndsWith("Cache", StringComparison.OrdinalIgnoreCase) || name == "Crashpad") continue;
            CopyDirectory(folder, Path.Combine(destination, name));
        }
    }

    private void ViewDataFolder()
    {
        if (dataRoot == null) return;
        if (MessageBox.Show(this, dataRoot, "当前资料目录 · 打开文件夹？", MessageBoxButtons.OKCancel) == DialogResult.OK)
            Process.Start(new ProcessStartInfo(dataRoot) { UseShellExecute = true });
    }

    private void ChooseDataFolder()
    {
        if (dataRoot == null || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("YAMS_ONE_DESKTOP_DATA_DIR"))) return;
        using (var picker = new FolderBrowserDialog { Description = "选择空文件夹作为资料目录", ShowNewFolderButton = true })
        {
            if (picker.ShowDialog(this) != DialogResult.OK) return;
            try
            {
                string destination = Path.GetFullPath(picker.SelectedPath);
                if (destination.StartsWith(dataRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                    || Directory.GetFileSystemEntries(destination).Length != 0)
                    throw new IOException("请选择资料目录外的空文件夹。");
                if (MessageBox.Show(this, "请先保存正在编辑的记录。确定后程序将关闭，下次打开时迁移资料。原资料会保留。", "更改资料目录", MessageBoxButtons.OKCancel) != DialogResult.OK) return;
                File.WriteAllText(locationFile + ".pending", destination);
                CloseWithoutExitPrompt();
            }
            catch (Exception error) { MessageBox.Show(this, error.Message, Text); }
        }
    }

    private async void OpenWorkspace(object sender, EventArgs args)
    {
        try
        {
            dataRoot = LoadDataFolder();
            Directory.CreateDirectory(dataRoot);
            InstallationLayoutMigration.Migrate(AppDomain.CurrentDomain.BaseDirectory);
            splashEnabled = !File.Exists(SplashPreferencePath);
            pdfInvertEnabled = File.Exists(PdfInvertPreferencePath);
            string assets = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "workspace");
            string data = Path.Combine(dataRoot, "Workspace");
            if (!File.Exists(Path.Combine(assets, "index.html")))
                throw new FileNotFoundException("请先解压完整的桌面版文件夹，再运行程序。");

            var environment = await CoreWebView2Environment.CreateAsync(null, data);
            await browser.EnsureCoreWebView2Async(environment);
            var web = browser.CoreWebView2;
            web.Settings.AreDevToolsEnabled = false;
            web.Settings.IsStatusBarEnabled = false;
            web.Settings.AreHostObjectsAllowed = false;
            web.Settings.IsWebMessageEnabled = true;
            web.SetVirtualHostNameToFolderMapping(WorkspaceHost, assets, CoreWebView2HostResourceAccessKind.Deny);
            web.NavigationStarting += (s, e) =>
            {
                if (IsWorkspace(e.Uri))
                {
                    EndStartupSplash();
                    return;
                }
                e.Cancel = true;
                if (e.IsUserInitiated) OpenExternalLink(e.Uri);
            };
            web.ProcessFailed += (s, e) => EndStartupSplash();
            web.NewWindowRequested += (s, e) => OpenRequestedWindow(environment, e);
            web.WebMessageReceived += HandleWorkspaceMessage;
            web.Navigate(WorkspaceUrl);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show("需要 Microsoft Edge WebView2 运行时。安装后重新打开 DoNote。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            CloseWithoutExitPrompt();
        }
        catch (Exception error)
        {
            MessageBox.Show("无法打开工作台。\n\n" + error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            CloseWithoutExitPrompt();
        }
    }

    private async void HandleWorkspaceMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        var web = (CoreWebView2)sender;
        if (!string.Equals(args.Source, WorkspaceUrl, StringComparison.Ordinal))
            return;
        if (HandleLivePageCommand(web, args)) return;
        if (args.WebMessageAsJson.StartsWith("{", StringComparison.Ordinal))
        {
            string objectMessage = args.WebMessageAsJson;
            if (await HandleVideoTranscribe(web, objectMessage)) return;
            if (await HandleDocumentTranslationMessage(web, objectMessage)) return;
            if (await HandleMinerUReflowMessage(web, objectMessage)) return;
            if (HandleLargeBackupMessage(web, objectMessage)) return;
            if (HandleAiModelMessage(web, args.WebMessageAsJson)) return;
            if (await HandleAiCredentialMessage(web, args.WebMessageAsJson)) return;
            await HandleWebCapture(web, args.WebMessageAsJson);
            return;
        }
        string command;
        try { command = args.TryGetWebMessageAsString(); }
        catch (ArgumentException) { return; }
        catch (InvalidOperationException) { return; }
        if (TryApplyChromeMessage(command)) return;
        if (command != null && command.StartsWith(LocalSubtitlePrefix, StringComparison.Ordinal))
        {
            await HandleLocalSubtitleTranslation(web, command);
            return;
        }
        if (command != null && command.StartsWith("translation:", StringComparison.Ordinal))
        {
            await HandleTranslationCommand(web, command);
            return;
        }
        switch (command)
        {
            case "startup-ready":
                SendPreferences(web);
                if (!startupHandled && splashEnabled)
                    OfferStartupSplash(web);
                startupHandled = true;
                return;
            case "startup-splash-enter":
                if (startupSplashPending)
                {
                    startupSplashPending = false;
                    chromePanel.Hide();
                }
                return;
            case "startup-splash-exit":
                EndStartupSplash();
                return;
            case "toggle-startup":
                ToggleSplash(web);
                return;
            case "toggle-pdf-invert":
                TogglePdfInvert(web);
                return;
            case "view-data-folder":
                ViewDataFolder();
                return;
            case "choose-data-folder":
                ChooseDataFolder();
                return;
            case "models:open-asr":
                OpenAsrModelDirectory();
                return;
            case "install-update":
                BeginLocalUpdate();
                return;
            case "exit-desktop":
                Close();
                return;
        }
        if (command != "start-local-ai") return;
        if (bridgeStarting) return;
        bridgeStarting = true;
        try
        {
            var connection = await StartLocalBridge();
            PostWorkspaceMessage(web, new { type = "yams-one-local-ai", baseUrl = connection.baseUrl, adminToken = connection.adminToken });
        }
        catch (Exception error)
        {
            PostWorkspaceMessage(web, new { type = "yams-one-local-ai", error = error.Message });
        }
        finally { bridgeStarting = false; }
    }

    private void PostWorkspaceMessage(CoreWebView2 web, object message)
    {
        if (!IsDisposed && !Disposing && string.Equals(web.Source, WorkspaceUrl, StringComparison.Ordinal))
            web.PostWebMessageAsJson(json.Serialize(message));
    }

    private static bool IsPublicWebAddress(string value, out Uri uri)
    {
        uri = null;
        if (string.IsNullOrWhiteSpace(value) || value.Length > 2048 || !Uri.TryCreate(value, UriKind.Absolute, out uri) ||
            (uri.Scheme != "https" && uri.Scheme != "http") || uri.HostNameType != UriHostNameType.Dns ||
            !uri.IsDefaultPort || uri.UserInfo.Length != 0) return false;
        string host = uri.IdnHost.TrimEnd('.').ToLowerInvariant();
        string suffix = host.Substring(host.LastIndexOf('.') + 1);
        return host.Contains(".") && host != WorkspaceHost && !host.EndsWith(".home.arpa", StringComparison.Ordinal) &&
            suffix != "localhost" && suffix != "local" && suffix != "internal" && suffix != "lan" &&
            suffix != "test" && suffix != "onion" && suffix != "invalid";
    }

    private async Task HandleWebCapture(CoreWebView2 web, string requestJson)
    {
        if (requestJson.Length > 32000) return;
        Dictionary<string, object> request;
        try
        {
            request = new JavaScriptSerializer { MaxJsonLength = 32000, RecursionLimit = 8 }
                .Deserialize<Dictionary<string, object>>(requestJson);
        }
        catch (ArgumentException) { return; }
        catch (InvalidOperationException) { return; }

        object type, identifier;
        Guid id;
        if (request == null || !request.TryGetValue("type", out type) || (type as string) != "capture-web-article" ||
            !request.TryGetValue("id", out identifier) || !Guid.TryParse(identifier as string, out id)) return;

        string error;
        if (captureProcess != null) error = "另一个网页正在收藏，请稍后再试。";
        else
        {
            var program = AppDomain.CurrentDomain.BaseDirectory;
            var worker = Path.Combine(program, "ai-bridge", "workers", "web-fetch.mjs");
            var node = Path.Combine(program, "ai-bridge", "node.exe");
            if (File.Exists(worker) && File.Exists(node))
            {
                var info = new ProcessStartInfo(node, "\"" + worker + "\"")
                {
                    WorkingDirectory = program,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    StandardOutputEncoding = Encoding.UTF8,
                };
                foreach (var variable in new[] { "NODE_OPTIONS", "NODE_PATH", "NODE_USE_ENV_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED" })
                    info.EnvironmentVariables.Remove(variable);
                using (var process = new Process { StartInfo = info })
                {
                    captureProcess = process;
                    try
                    {
                        if (!process.Start()) throw new InvalidOperationException();
                        var output = process.StandardOutput.ReadToEndAsync();
                        var bytes = Encoding.UTF8.GetBytes(requestJson);
                        await process.StandardInput.BaseStream.WriteAsync(bytes, 0, bytes.Length);
                        process.StandardInput.Close();
                        if (await Task.WhenAny(output, Task.Delay(27000)) == output)
                        {
                            string response = await output;
                            if (!IsDisposed && !Disposing && response.Length != 0 &&
                                string.Equals(web.Source, WorkspaceUrl, StringComparison.Ordinal))
                                web.PostWebMessageAsJson(response);
                            if (response.Length != 0) return;
                            error = "网页读取失败，请重试。";
                        }
                        else error = "读取网页超时。";
                    }
                    catch (Exception) { error = "网页读取失败，请重试。"; }
                    finally
                    {
                        StopWebCapture();
                        captureProcess = null;
                    }
                }
            }
            else error = "网页收藏组件缺失，请重新解压完整桌面版。";
        }
        PostWorkspaceMessage(web, new { type = "yams-one-web-capture", id = identifier, error });
    }

    private void StopWebCapture()
    {
        if (captureProcess == null) return;
        try { if (!captureProcess.HasExited) captureProcess.Kill(); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }

    private Task<BridgeConnection> bridgeStartTask;

    private async Task<BridgeConnection> StartLocalBridge()
    {
        var startup = bridgeStartTask ?? (bridgeStartTask = StartLocalBridgeCore());
        try { return await startup; }
        finally { if (bridgeStartTask == startup) bridgeStartTask = null; }
    }

    private async Task<BridgeConnection> StartLocalBridgeCore()
    {
        if (bridgeProcess != null && !bridgeProcess.HasExited && bridgeConnection != null)
            return bridgeConnection;
        StopLocalBridge();
        string service = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ai-bridge");
        string script = Path.Combine(service, "server.mjs");
        string executable = Path.Combine(service, "node.exe");
        string runtime = Path.Combine(dataRoot, "AiBridge");
        if (!File.Exists(executable) || !File.Exists(script))
            throw new FileNotFoundException("本机 AI 服务文件缺失，请重新解压完整桌面版。");
        string portSetting = Environment.GetEnvironmentVariable("YAMS_ONE_DESKTOP_BRIDGE_PORT");
        int port;
        if (!int.TryParse(portSetting, NumberStyles.None, CultureInfo.InvariantCulture, out port) || port > 65535)
            port = 4318;
        var reused = await TryReuseLocalBridge(runtime, port, executable);
        if (reused != null)
        {
            bridgeConnection = reused;
            return reused;
        }
        var info = new ProcessStartInfo(executable, "\"" + script + "\"")
        {
            WorkingDirectory = service,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
        };
        info.EnvironmentVariables["ANALOG_BIND"] = "127.0.0.1";
        info.EnvironmentVariables["PORT"] = port.ToString(CultureInfo.InvariantCulture);
        info.EnvironmentVariables["ANALOG_DATA_DIR"] = runtime;
        info.EnvironmentVariables["ANALOG_DESKTOP_MANAGED"] = "1";
        foreach (string key in new[] { "ANALOG_ADMIN_TOKEN", "ANALOG_ALLOWED_ORIGINS", "NODE_OPTIONS", "NODE_PATH" })
            info.EnvironmentVariables.Remove(key);

        var ready = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        process.OutputDataReceived += (sender, args) =>
        {
            if (args.Data != null && args.Data.StartsWith(BridgeReadyPrefix, StringComparison.Ordinal))
                ready.TrySetResult(args.Data.Substring(BridgeReadyPrefix.Length));
            if (args.Data == null) ready.TrySetResult(null);
        };
        bridgeProcess = process;
        try
        {
            if (!process.Start()) throw new InvalidOperationException("本机 AI 服务无法启动。");
            int pid = process.Id;
            process.BeginOutputReadLine();
            var completed = await Task.WhenAny(ready.Task, Task.Delay(12000));
            if (completed != ready.Task || ready.Task.Result == null || process.HasExited)
                throw new InvalidOperationException("本机 AI 服务未能启动。请检查是否已有服务占用 " + port + " 端口，再重试。");

            var handshake = json.Deserialize<BridgeReady>(ready.Task.Result);
            var connection = json.Deserialize<BridgeConnection>(File.ReadAllText(Path.Combine(runtime, "connection.json")));
            Uri address;
            Version bridgeVersion;
            if (handshake == null || handshake.pid != pid ||
                !Version.TryParse(handshake.version, out bridgeVersion) || bridgeVersion < RequiredLocalBridgeVersion ||
                connection == null || connection.baseUrl != handshake.baseUrl
                || !Uri.TryCreate(connection.baseUrl, UriKind.Absolute, out address) || address.Scheme != "http"
                || address.Host != "127.0.0.1" || address.Port < 1 || (port != 0 && address.Port != port)
                || address.AbsolutePath != "/" || address.UserInfo.Length != 0 || address.Query.Length != 0 || address.Fragment.Length != 0
                || string.IsNullOrWhiteSpace(connection.adminToken) || connection.adminToken.Length < 24 || connection.adminToken.Length > 512
                || connection.adminToken.IndexOfAny(new[] { '\r', '\n' }) >= 0)
                throw new InvalidOperationException("本机 AI 服务返回的连接信息无效。");
            bridgeConnection = connection;
            return connection;
        }
        catch
        {
            StopLocalBridge();
            throw;
        }
    }

    private void StopLocalBridge()
    {
        var process = bridgeProcess;
        bridgeProcess = null;
        bridgeConnection = null;
        if (process == null) return;
        try
        {
            if (!process.HasExited)
            {
                process.StandardInput.Close();
                if (!process.WaitForExit(1500))
                {
                    process.Kill();
                    process.WaitForExit(1500);
                }
            }
        }
        catch (InvalidOperationException) { }
        catch (IOException) { }
        catch (System.ComponentModel.Win32Exception) { }
        finally { process.Dispose(); }
    }

    private sealed class BridgeReady
    {
        public BridgeReady() { }
        public string version { get; set; }
        public string baseUrl { get; set; }
        public int pid { get; set; }
    }

    private sealed class BridgeConnection
    {
        public BridgeConnection() { }
        public string baseUrl { get; set; }
        public string adminToken { get; set; }
        public int pid { get; set; }
    }

    private async void OpenRequestedWindow(CoreWebView2Environment environment, CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        if (!args.IsUserInitiated) return;
        string target = args.Uri;
        string prefix = "blob:https://" + WorkspaceHost + "/";
        Guid blobId;
        if (string.IsNullOrEmpty(target) || !target.StartsWith(prefix, StringComparison.Ordinal) || !Guid.TryParse(target.Substring(prefix.Length), out blobId))
        {
            OpenExternalLink(target);
            return;
        }
        var deferral = args.GetDeferral();
        var window = new Form { Text = "DoNote · 原图", Icon = Icon, Size = new Size(1000, 760), StartPosition = FormStartPosition.CenterParent };
        var view = new WebView2 { Dock = DockStyle.Fill };
        window.Controls.Add(view);
        try
        {
            await view.EnsureCoreWebView2Async(environment);
            var popup = view.CoreWebView2;
            popup.Settings.IsScriptEnabled = false;
            popup.Settings.IsWebMessageEnabled = false;
            popup.Settings.AreHostObjectsAllowed = false;
            popup.Settings.AreDevToolsEnabled = false;
            popup.NavigationStarting += (sender, e) => { if (e.Uri != target) e.Cancel = true; };
            popup.NewWindowRequested += (sender, e) => { e.Handled = true; };
            args.NewWindow = popup;
            window.Show(this);
        }
        catch (Exception)
        {
            window.Dispose();
            MessageBox.Show("原图窗口无法打开，可从阅读器下载原图。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        finally { deferral.Complete(); }
    }

    private static bool IsWorkspace(string url)
    {
        Uri uri;
        return Uri.TryCreate(url, UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.Host == WorkspaceHost && uri.IsDefaultPort;
    }

    private static void OpenExternalLink(string url)
    {
        Uri uri;
        if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || (uri.Scheme != "https" && uri.Scheme != "http") || IsWorkspace(url))
            return;
        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            MessageBox.Show("无法打开外部链接。\n\n" + error.Message, "DoNote", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}

