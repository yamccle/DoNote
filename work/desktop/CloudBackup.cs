/*
 * [INPUT]: 接收工作台云备份命令、保留份数策略、原生目录选择和已完成的本地快照。
 * [OUTPUT]: 保存加密连接设置，执行上传后旧版本清理，并发送备份列表、传输进度与结果。
 * [POS]: Windows 宿主连接现有大文件备份写入器与云备份传输。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

internal sealed class CloudBackupSettings
{
    public string mode { get; set; }
    public string folder { get; set; }
    public string url { get; set; }
    public string username { get; set; }
    public string password { get; set; }
    public int keepCount { get; set; }
}

internal sealed partial class WorkspaceWindow
{
    private static readonly byte[] CloudConnectionEntropy = Encoding.UTF8.GetBytes("DoNote.CloudBackup.v1");
    private readonly JavaScriptSerializer cloudBackupJson = new JavaScriptSerializer { MaxJsonLength = 16384 };
    private CancellationTokenSource cloudBackupCancellation;
    private string cloudFolderChoice, cloudStage, cloudCompletedSnapshot;
    private string CloudTransferRoot { get { return Path.Combine(dataRoot, "CloudTransfer"); } }
    private string CloudSettingsPath { get { return Path.Combine(dataRoot, "CloudBackup.bin"); } }

    private static string CloudValue(Dictionary<string, object> request, string key)
    {
        object item;
        return request.TryGetValue(key, out item) ? item as string : null;
    }

    private static int ParseKeepCount(Dictionary<string, object> request, int fallback)
    {
        object raw;
        if (!request.TryGetValue("keepCount", out raw) || raw == null) return NormalizeKeepCount(fallback);
        int parsed;
        if (raw is int) parsed = (int)raw;
        else if (!Int32.TryParse(Convert.ToString(raw), out parsed))
            throw new InvalidDataException("保留备份份数无效。");
        if (parsed < 0 || parsed > 200) throw new InvalidDataException("保留备份份数需在 0 到 200 之间。");
        return parsed;
    }

    private static int NormalizeKeepCount(int value)
    {
        return value < 0 || value > 200 ? 0 : value;
    }

    private static object CloudView(CloudBackupSettings settings)
    {
        return new
        {
            mode = settings.mode,
            folder = settings.folder ?? "",
            url = settings.url ?? "",
            username = settings.username ?? "",
            hasPassword = !String.IsNullOrEmpty(settings.password),
            keepCount = NormalizeKeepCount(settings.keepCount)
        };
    }

    private CloudBackupSettings ReadCloudSettings()
    {
        if (!File.Exists(CloudSettingsPath)) return new CloudBackupSettings { mode = "folder" };
        try
        {
            var bytes = ProtectedData.Unprotect(File.ReadAllBytes(CloudSettingsPath), CloudConnectionEntropy, DataProtectionScope.CurrentUser);
            var settings = cloudBackupJson.Deserialize<CloudBackupSettings>(Encoding.UTF8.GetString(bytes));
            if (settings == null || (settings.mode != "folder" && settings.mode != "webdav"))
                throw new InvalidDataException("云备份设置无效。");
            settings.keepCount = NormalizeKeepCount(settings.keepCount);
            return settings;
        }
        catch (CryptographicException)
        {
            throw new InvalidDataException("当前 Windows 用户无法读取云备份设置，请重新配置。");
        }
    }

    private void SaveCloudSettings(CloudBackupSettings settings)
    {
        var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(cloudBackupJson.Serialize(settings)),
            CloudConnectionEntropy, DataProtectionScope.CurrentUser);
        var pending = CloudSettingsPath + "." + Guid.NewGuid().ToString("N") + ".pending";
        try
        {
            File.WriteAllBytes(pending, bytes);
            if (File.Exists(CloudSettingsPath)) File.Replace(pending, CloudSettingsPath, null);
            else File.Move(pending, CloudSettingsPath);
        }
        finally
        {
            try { File.Delete(pending); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static bool CloudWithin(string directory, string root)
    {
        var prefix = Path.GetFullPath(root).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
        var target = Path.GetFullPath(directory).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
        return target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    private void ValidateCloudFolder(string directory)
    {
        if (!Directory.Exists(directory)) throw new DirectoryNotFoundException("所选目录不可用，请检查网盘客户端或重新选择。");
        if (CloudWithin(directory, dataRoot) || CloudWithin(directory, AppDomain.CurrentDomain.BaseDirectory))
            throw new InvalidDataException("请选择位于软件安装和资料目录之外的文件夹。");
    }

    private string ChooseCloudFolder(string description)
    {
        using (var picker = new FolderBrowserDialog { Description = description, ShowNewFolderButton = true })
        {
            if (picker.ShowDialog(this) != DialogResult.OK) return null;
            var folder = Path.GetFullPath(picker.SelectedPath);
            ValidateCloudFolder(folder);
            return folder;
        }
    }

    private CloudBackupSettings ConfigureCloud(Dictionary<string, object> request)
    {
        CloudBackupSettings current;
        try { current = ReadCloudSettings(); }
        catch (InvalidDataException) { current = new CloudBackupSettings(); }
        var mode = CloudValue(request, "mode");
        var settings = new CloudBackupSettings { mode = mode, keepCount = ParseKeepCount(request, current.keepCount) };
        if (mode == "folder")
        {
            var requested = CloudValue(request, "folder");
            var trusted = new[] { cloudFolderChoice, current.folder }.FirstOrDefault(path =>
                !String.IsNullOrEmpty(path) && String.Equals(path, requested, StringComparison.OrdinalIgnoreCase));
            if (String.IsNullOrEmpty(trusted)) throw new InvalidDataException("请通过系统目录选择器选取同步文件夹。");
            ValidateCloudFolder(trusted);
            settings.folder = trusted;
        }
        else if (mode == "webdav")
        {
            settings.username = CloudValue(request, "username") ?? "";
            settings.password = CloudValue(request, "password") ?? "";
            settings.url = CloudBackupTransport.ValidateEndpoint(CloudValue(request, "url"), settings.username, settings.password).AbsoluteUri;
            object clear;
            if (request.TryGetValue("clearPassword", out clear) && Object.Equals(clear, true)) settings.password = "";
            else if (settings.password.Length == 0 && current.mode == "webdav" &&
                String.Equals(current.url, settings.url, StringComparison.Ordinal) &&
                String.Equals(current.username, settings.username, StringComparison.Ordinal))
                settings.password = current.password;
        }
        else throw new InvalidDataException("请选择备份连接类型。");
        SaveCloudSettings(settings);
        return settings;
    }

    private CloudBackupTransport OpenCloudTransport()
    {
        var settings = ReadCloudSettings();
        if (settings.mode == "webdav")
            return new CloudBackupTransport(null, settings.url, settings.username, settings.password);
        if (String.IsNullOrEmpty(settings.folder))
            throw new InvalidDataException("请先选择并保存同步目录。");
        ValidateCloudFolder(settings.folder);
        return new CloudBackupTransport(settings.folder, null, null, null);
    }

    private bool IsCloudBackupRoot(string root)
    {
        return cloudStage != null && String.Equals(root, cloudStage, StringComparison.OrdinalIgnoreCase);
    }

    private void RememberCompletedCloudBackup(string target)
    {
        if (!IsCloudBackupRoot(Path.GetDirectoryName(target))) return;
        if (!CloudBackupTransport.ValidName(Path.GetFileName(target)) || !File.Exists(Path.Combine(target, "backup.json")))
            throw new InvalidDataException("云备份缺少已完成的快照清单。");
        cloudCompletedSnapshot = target;
    }

    private void DiscardCloudStage()
    {
        if (cloudStage == null) return;
        if (IsCloudBackupRoot(nativeBackupChosenRoot)) StopNativeBackup(true);
        CloudBackupTransport.RemoveTransferDirectory(CloudTransferRoot, cloudStage);
        cloudStage = cloudCompletedSnapshot = null;
    }

    private void StopCloudBackupTransfer()
    {
        if (cloudBackupCancellation != null) cloudBackupCancellation.Cancel();
        else DiscardCloudStage();
    }

    private async Task<bool> HandleCloudBackupMessage(CoreWebView2 web, string requestJson)
    {
        if (requestJson.IndexOf("cloud-backup", StringComparison.Ordinal) < 0) return false;
        Dictionary<string, object> request;
        try { request = cloudBackupJson.Deserialize<Dictionary<string, object>>(requestJson); }
        catch { return false; }
        if (request == null || CloudValue(request, "type") != "cloud-backup") return false;
        Guid requestId;
        if (!Guid.TryParse(CloudValue(request, "id"), out requestId)) return true;
        var id = requestId.ToString("D");
        var action = CloudValue(request, "action");
        try
        {
            if (action == "status")
                PostWorkspaceMessage(web, new { type = "cloud-backup-result", id, settings = CloudView(ReadCloudSettings()) });
            else if (action == "cancel")
            {
                if (cloudBackupCancellation != null) cloudBackupCancellation.Cancel();
                PostWorkspaceMessage(web, new { type = "cloud-backup-result", id, acknowledged = true });
            }
            else
            {
                if (cloudBackupCancellation != null) throw new InvalidOperationException("已有云备份任务正在执行。");
                if (action == "choose-folder")
                {
                    var chosen = ChooseCloudFolder("选择 Google Drive 桌面版或其他网盘客户端的同步文件夹");
                    if (chosen != null) cloudFolderChoice = chosen;
                    PostWorkspaceMessage(web, new { type = "cloud-backup-result", id, folder = chosen, cancelled = chosen == null });
                }
                else if (action == "configure")
                    PostWorkspaceMessage(web, new { type = "cloud-backup-result", id, settings = CloudView(ConfigureCloud(request)) });
                else if (action == "stage")
                {
                    if (nativeBackupTarget != null) throw new InvalidOperationException("已有本地备份任务正在执行。");
                    using (OpenCloudTransport()) { }
                    DiscardCloudStage();
                    cloudStage = Path.Combine(CloudTransferRoot, ".DoNote-transfer-" + Guid.NewGuid().ToString("N"));
                    Directory.CreateDirectory(cloudStage);
                    nativeBackupChosenRoot = cloudStage;
                    PostWorkspaceMessage(web, new { type = "cloud-backup-result", id });
                }
                else if (action == "discard")
                {
                    DiscardCloudStage();
                    PostWorkspaceMessage(web, new { type = "cloud-backup-result", id });
                }
                else if (action == "list" || action == "upload" || action == "download")
                    await RunCloudTransfer(web, id, action, CloudValue(request, "name"));
                else throw new InvalidOperationException("云备份操作未知。");
            }
        }
        catch (OperationCanceledException)
        {
            PostWorkspaceMessage(web, new { type = "cloud-backup-result", id, cancelled = true });
        }
        catch (Exception error)
        {
            var message = error is HttpRequestException ? "WebDAV 网络请求失败，请检查服务器地址、证书和网络连接。"
                : error is InvalidOperationException || error is InvalidDataException ||
                  error is IOException || error is UnauthorizedAccessException
                ? error.Message : "云备份操作失败，完成的快照和本机工作台资料保持原位。";
            PostWorkspaceMessage(web, new { type = "cloud-backup-result", id, error = message });
        }
        return true;
    }

    private async Task RunCloudTransfer(CoreWebView2 web, string id, string action, string name)
    {
        string destination = null;
        if (action != "list" && !CloudBackupTransport.ValidName(name))
            throw new InvalidDataException("备份版本无效。");
        if (action == "upload" &&
            (cloudCompletedSnapshot == null || Path.GetFileName(cloudCompletedSnapshot) != name ||
            !IsCloudBackupRoot(Path.GetDirectoryName(cloudCompletedSnapshot))))
            throw new InvalidOperationException("请先生成当前工作台的备份快照。");
        if (action == "download")
        {
            destination = ChooseCloudFolder("选择保存已验证备份的本地目录");
            if (destination == null) throw new OperationCanceledException();
        }
        var progress = new Progress<CloudBackupProgress>(value =>
            PostWorkspaceMessage(web, new { type = "cloud-backup-progress", id, message = value.Message, done = value.Done, total = value.Total }));
        using (var transport = OpenCloudTransport())
        using (var cancellation = new CancellationTokenSource())
        {
            cloudBackupCancellation = cancellation;
            object result = null;
            ExceptionDispatchInfo failure = null;
            var token = cancellation.Token;
            try
            {
                if (action == "list")
                {
                    var snapshots = await Task.Run(() => transport.ListAsync(token));
                    result = new { type = "cloud-backup-result", id, snapshots = snapshots.Select(entry => new { name = entry }).ToArray() };
                }
                else if (action == "upload")
                {
                    var source = cloudCompletedSnapshot;
                    var keepCount = NormalizeKeepCount(ReadCloudSettings().keepCount);
                    await Task.Run(() => transport.UploadAsync(name, source, progress, token));
                    var pruned = 0;
                    string pruneWarning = null;
                    if (keepCount > 0)
                    {
                        try { pruned = await Task.Run(() => transport.PruneAsync(keepCount, token)); }
                        catch (OperationCanceledException) { throw; }
                        catch (Exception pruneError) { pruneWarning = pruneError.Message; }
                    }
                    result = new { type = "cloud-backup-result", id, name, pruned, pruneWarning };
                }
                else
                {
                    var path = await Task.Run(() => transport.DownloadAsync(name, destination, progress, token));
                    result = new { type = "cloud-backup-result", id, path };
                }
            }
            catch (Exception error) { failure = ExceptionDispatchInfo.Capture(error); }
            try { if (action == "upload") await Task.Run(() => DiscardCloudStage()); }
            finally { cloudBackupCancellation = null; }
            if (failure != null) { token.ThrowIfCancellationRequested(); failure.Throw(); }
            PostWorkspaceMessage(web, result);
        }
    }
}
