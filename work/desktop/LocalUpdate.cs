/*
 * [INPUT]: 接收本地 ZIP 更新请求或 WebView2 在线检查/下载 GitHub Releases 消息。
 * [OUTPUT]: 规划到最新版的更新路径。下载并校验每个 ZIP 后交给更新器。
 * [POS]: 桌面端本地与在线自动更新入口，严格保护用户 Data/ 与 models/ 目录。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

internal sealed partial class WorkspaceWindow
{
    private const string DefaultReleaseApiUrl = "https://api.github.com/repos/yamccle/DoNote/releases/latest";
    private const string AllowedDownloadPrefix = "https://github.com/yamccle/DoNote/releases/download/";
    private bool updateChecking;
    private CancellationTokenSource onlineUpdateCancel;
    private string offeredUpdateId, downloadingUpdateId;
    private List<OnlineUpdateStep> offeredUpdate;
    private TaskCompletionSource<string> workspaceReadyForUpdate;

    private string ReadInstalledVersion(string installDirectory)
    {
        var manifestPath = Path.Combine(installDirectory, "release-manifest.json");
        if (!File.Exists(manifestPath)) return "26.1105.0001";
        try
        {
            var manifest = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 }
                .Deserialize<ReleaseManifest>(File.ReadAllText(manifestPath));
            return manifest != null && !string.IsNullOrWhiteSpace(manifest.version) ? manifest.version : "26.1105.0001";
        }
        catch { return "26.1105.0001"; }
    }

    private void LaunchUpdaterAndExit(string package, string installDirectory, bool chain = false)
    {
        var helper = Path.Combine(installDirectory, "DoNoteUpdater.exe");
        if (!File.Exists(helper)) throw new FileNotFoundException("当前版本没有更新助手，请先覆盖安装支持更新的版本。");
        var temporary = chain ? Path.GetDirectoryName(package) : Path.Combine(Path.GetTempPath(), "DoNote-Update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporary);
        var copiedHelper = Path.Combine(temporary, "DoNoteUpdater.exe");
        File.Copy(helper, copiedHelper);
        Process.Start(new ProcessStartInfo(copiedHelper)
        {
            Arguments = Quote(package) + " " + Quote(installDirectory) + " " + Quote(dataRoot) + " " + Process.GetCurrentProcess().Id + (chain ? " --chain" : ""),
            UseShellExecute = false,
            WorkingDirectory = temporary
        });
        CloseWithoutExitPrompt();
    }

    private async void BeginLocalUpdate()
    {
        if (updateChecking || onlineUpdateCancel != null) return;
        updateChecking = true;
        try
        {
            string package;
            using (var picker = new OpenFileDialog { Title = "选择 DoNote 更新包", Filter = "DoNote 更新包 (*.zip)|*.zip", CheckFileExists = true })
            {
                if (picker.ShowDialog(this) != DialogResult.OK) return;
                package = picker.FileName;
            }
            var installDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            var preflight = await Task.Run(() =>
            {
                var manifest = UpdatePackage.Read(package, false);
                return Tuple.Create(manifest, UpdatePackage.CheckVersion(manifest, installDirectory));
            });
            if (IsDisposed || Disposing) return;
            var incoming = preflight.Item1;
            var current = preflight.Item2;
            var patch = !String.IsNullOrWhiteSpace(incoming.baseVersion);
            string message = "当前版本：" + current + "\n目标版本：" + incoming.version
                + "\n更新方式：" + (patch ? "增量补丁（仅变化文件）" : "完整包")
                + "\n\n更新助手将先备份被替换的程序文件，安装失败会自动恢复。请先保存正在编辑的内容。现在开始吗？";
            if (MessageBox.Show(this, message, "安装 DoNote 更新", MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.OK) return;
            LaunchUpdaterAndExit(package, installDirectory);
        }
        catch (Exception error)
        {
            if (!IsDisposed && !Disposing)
                MessageBox.Show(this, error.Message, "无法安装更新", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally { updateChecking = false; }
    }

    private void StopOnlineUpdateDownload()
    {
        var cts = onlineUpdateCancel;
        onlineUpdateCancel = null;
        if (cts != null)
        {
            try { cts.Cancel(); } catch { }

        }
    }

    private static HttpClient CreateUpdateHttpClient(TimeSpan timeout)
    {
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        var handler = new HttpClientHandler { AllowAutoRedirect = true };
        var client = new HttpClient(handler) { Timeout = timeout };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("DoNote-Desktop-Updater/1.0");
        client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return client;
    }

    private static bool IsAllowedUpdateUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return false;
        string customFeed = Environment.GetEnvironmentVariable("DONOTE_UPDATE_FEED_URL");
        if (!string.IsNullOrWhiteSpace(customFeed))
        {
            Uri feedUri, targetUri;
            if (Uri.TryCreate(customFeed, UriKind.Absolute, out feedUri) && Uri.TryCreate(url, UriKind.Absolute, out targetUri)
                && string.Equals(feedUri.Host, targetUri.Host, StringComparison.OrdinalIgnoreCase) && feedUri.Port == targetUri.Port)
                return true;
        }
        return url.StartsWith(AllowedDownloadPrefix, StringComparison.OrdinalIgnoreCase);
    }

    private async Task<bool> HandleOnlineUpdateMessage(CoreWebView2 web, string requestJson)
    {
        if (requestJson.Length > 32768 || requestJson.IndexOf("\"online-update\"", StringComparison.Ordinal) < 0) return false;
        Dictionary<string, object> request;
        try { request = new JavaScriptSerializer { MaxJsonLength = 32768, RecursionLimit = 6 }.Deserialize<Dictionary<string, object>>(requestJson); }
        catch { return false; }
        if (GetUpdateString(request, "type") != "online-update") return false;
        var action = GetUpdateString(request, "action");
        var id = GetUpdateString(request, "id");
        var installDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        if (action == "check")
        {
            var silent = id.StartsWith("silent-", StringComparison.Ordinal);
            if (!silent) { offeredUpdateId = id; offeredUpdate = null; }
            try { await OfferOnlineUpdate(web, id, installDirectory, silent); }
            catch (Exception error)
            {
                PostWorkspaceMessage(web, new { type = "online-update-result", id, error = "检查更新失败：" + error.Message });
            }
        }
        else if (action == "download")
        {
            if (updateChecking || onlineUpdateCancel != null)
                PostWorkspaceMessage(web, new { type = "online-update-result", id, error = "已有更新任务正在进行。" });
            else if (GetUpdateString(request, "planId") != offeredUpdateId || offeredUpdate == null)
                PostWorkspaceMessage(web, new { type = "online-update-result", id, error = "更新方案已失效，请重新检查。" });
            else await DownloadAndInstallOnlineUpdate(web, id, installDirectory, offeredUpdate);
        }
        else if (action == "cancel" && id == downloadingUpdateId && onlineUpdateCancel != null)
            onlineUpdateCancel.Cancel();
        else if (action == "ready" && id == downloadingUpdateId && workspaceReadyForUpdate != null)
            workspaceReadyForUpdate.TrySetResult(GetUpdateString(request, "error"));
        return true;
    }

    private async Task OfferOnlineUpdate(CoreWebView2 web, string id, string installDirectory, bool silent)
    {
        var currentText = ReadInstalledVersion(installDirectory);
        var current = Version.Parse(currentText);
        var feedUrl = Environment.GetEnvironmentVariable("DONOTE_UPDATE_FEED_URL");
        var official = String.IsNullOrWhiteSpace(feedUrl) || String.Equals(feedUrl, DefaultReleaseApiUrl, StringComparison.OrdinalIgnoreCase);
        if (official) feedUrl = DefaultReleaseApiUrl;
        var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        using (var client = CreateUpdateHttpClient(TimeSpan.FromSeconds(25)))
        {
            var payload = await client.GetStringAsync(feedUrl);
            var releases = payload.TrimStart().StartsWith("[", StringComparison.Ordinal)
                ? new List<GitHubUpdateRelease>(serializer.Deserialize<GitHubUpdateRelease[]>(payload))
                : new List<GitHubUpdateRelease> { serializer.Deserialize<GitHubUpdateRelease>(payload) };
            var latest = releases.Where(release => release != null && release.ReadVersion() != null)
                .OrderByDescending(release => release.ReadVersion()).FirstOrDefault();
            if (latest == null) throw new InvalidDataException("发行版缺少有效的版本号。");
            var target = latest.ReadVersion();
            if (target <= current || silent)
            {
                PostWorkspaceMessage(web, new
                {
                    type = "online-update-result", id, hasUpdate = target > current, currentVersion = currentText,
                    remoteVersion = latest.VersionText(), tag = latest.tag_name
                });
                return;
            }
            if (official)
            {
                for (int page = 1; ; page++)
                {
                    var listUrl = "https://api.github.com/repos/yamccle/DoNote/releases?per_page=100&page=" + page;
                    var batch = serializer.Deserialize<GitHubUpdateRelease[]>(await client.GetStringAsync(listUrl));
                    releases.AddRange(batch.Where(release => release != null && release.tag_name != latest.tag_name));
                    if (batch.Length < 100) break;
                }
            }
            var rejected = new HashSet<GitHubUpdateAsset>();
            var checksums = new Dictionary<GitHubUpdateRelease, Dictionary<string, string>>();
            List<OnlineUpdateStep> plan;
            while (true)
            {
                plan = OnlineUpdatePlan.Find(current, target, releases,
                    asset => IsAllowedUpdateUrl(asset.browser_download_url) && !rejected.Contains(asset));
                if (plan == null)
                    throw new InvalidOperationException("找不到可校验且能升级到 " + latest.VersionText() + " 的更新路径。");
                foreach (var step in plan)
                {
                    step.Sha256 = await UpdateAssetHash(client, serializer, step, checksums);
                    if (!Regex.IsMatch(step.Sha256, @"\A[0-9a-fA-F]{64}\z")) rejected.Add(step.Asset);
                }
                if (plan.All(step => !rejected.Contains(step.Asset))) break;
            }
            if (id != offeredUpdateId) return;
            offeredUpdate = plan;
            var notes = latest.body ?? "";
            PostWorkspaceMessage(web, new
            {
                type = "online-update-result", id, hasUpdate = true, currentVersion = currentText,
                remoteVersion = latest.VersionText(), tag = latest.tag_name,
                downloadMode = plan.All(step => step.BaseVersion != null) ? "patch" : "full",
                assetSize = plan.Sum(step => step.Asset.size),
                versions = plan.Select(step => step.Release.VersionText()).ToArray(),
                releaseNotes = notes.Length > 2400 ? notes.Substring(0, 2400) + "…" : notes
            });
        }
    }

    private async Task<string> UpdateAssetHash(HttpClient client, JavaScriptSerializer serializer, OnlineUpdateStep step,
        Dictionary<GitHubUpdateRelease, Dictionary<string, string>> checksums)
    {
        var digest = step.Asset.digest ?? "";
        if (digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
        {
            var sha256 = digest.Substring(7).Trim();
            if (Regex.IsMatch(sha256, @"\A[0-9a-fA-F]{64}\z")) return sha256;
        }
        Dictionary<string, string> byName;
        if (!checksums.TryGetValue(step.Release, out byName))
        {
            byName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            checksums.Add(step.Release, byName);
            var meta = (step.Release.assets ?? new GitHubUpdateAsset[0]).FirstOrDefault(asset => asset != null &&
                String.Equals(asset.name, "DoNote-" + step.Release.tag_name + "-release.json", StringComparison.OrdinalIgnoreCase));
            if (meta != null && IsAllowedUpdateUrl(meta.browser_download_url))
            {
                try
                {
                    var report = serializer.Deserialize<Dictionary<string, object>>(await client.GetStringAsync(meta.browser_download_url));
                    object artifacts;
                    if (report != null && report.TryGetValue("artifacts", out artifacts) && artifacts is System.Collections.IList)
                        foreach (var item in (System.Collections.IList)artifacts)
                        {
                            var entry = item as Dictionary<string, object>;
                            byName[GetUpdateString(entry, "name")] = GetUpdateString(entry, "sha256");
                        }
                }
                catch (HttpRequestException) { }
                catch (ArgumentException) { }
                catch (InvalidOperationException) { }
            }
        }
        string hash;
        return byName.TryGetValue(step.Asset.name, out hash) ? hash : "";
    }

    private async Task DownloadAndInstallOnlineUpdate(CoreWebView2 web, string id, string installDirectory, List<OnlineUpdateStep> plan)
    {
        var cts = new CancellationTokenSource();
        onlineUpdateCancel = cts;
        downloadingUpdateId = id;
        var root = Path.Combine(Path.GetTempPath(), "DoNote-Update-" + Guid.NewGuid().ToString("N"));
        var handedOff = false;
        var total = plan.Sum(step => step.Asset.size);
        var progress = new Progress<Tuple<int, long>>(value =>
        {
            if (onlineUpdateCancel != cts || cts.IsCancellationRequested || IsDisposed || Disposing) return;
            var index = value.Item1;
            PostWorkspaceMessage(web, new
            {
                type = "online-update-progress", id, step = index + 1, steps = plan.Count,
                targetVersion = plan[index].Release.VersionText(),
                received = value.Item2, total, percent = (int)(value.Item2 * 100.0 / total)
            });
        });
        try
        {
            Directory.CreateDirectory(root);
            var current = ReadInstalledVersion(installDirectory);
            await Task.Run(() => DownloadUpdatePlan(root, current, plan, progress, cts.Token));
            cts.Token.ThrowIfCancellationRequested();
            await WaitForWorkspaceBeforeUpdate(web, id, cts.Token);
            cts.Token.ThrowIfCancellationRequested();
            LaunchUpdaterAndExit(Path.Combine(root, "chain.json"), installDirectory, true);
            handedOff = true;
        }
        catch (Exception error)
        {
            if (cts.IsCancellationRequested)
                PostWorkspaceMessage(web, new { type = "online-update-result", id, cancelled = true });
            else
                PostWorkspaceMessage(web, new { type = "online-update-result", id, error = "无法开始安装：" + error.Message });
        }
        finally
        {
            onlineUpdateCancel = null;
            downloadingUpdateId = null;
            cts.Dispose();
            if (!handedOff)
                try { if (Directory.Exists(root)) Directory.Delete(root, true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
        }
    }

    private async Task WaitForWorkspaceBeforeUpdate(CoreWebView2 web, string id, CancellationToken token)
    {
        var ready = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        workspaceReadyForUpdate = ready;
        try
        {
            PostWorkspaceMessage(web, new { type = "online-update-prepare", id });
            var finished = await Task.WhenAny(ready.Task, Task.Delay(TimeSpan.FromMinutes(2), token));
            token.ThrowIfCancellationRequested();
            if (finished != ready.Task) throw new TimeoutException("等待编辑内容暂存超时。");
            var error = await ready.Task;
            if (!String.IsNullOrWhiteSpace(error)) throw new IOException(error);
        }
        finally { workspaceReadyForUpdate = null; }
    }

    private static async Task DownloadUpdatePlan(string root, string current, List<OnlineUpdateStep> plan,
        IProgress<Tuple<int, long>> progress, CancellationToken token)
    {
        long completed = 0;
        var names = new string[plan.Count];
        using (var client = CreateUpdateHttpClient(TimeSpan.FromMinutes(30)))
        {
            for (var index = 0; index < plan.Count; index++)
            {
                var step = plan[index];
                if (step.BaseVersion != null && step.BaseVersion != Version.Parse(current))
                    throw new InvalidDataException("本机版本已变化，请重新检查更新。");
                names[index] = (index + 1).ToString("D3") + ".zip";
                var zip = Path.Combine(root, names[index]);
                progress.Report(Tuple.Create(index, completed));
                var stepIndex = index;
                await DownloadUpdateAsset(client, step, zip, received =>
                    progress.Report(Tuple.Create(stepIndex, completed + received)), token);
                var manifest = UpdatePackage.Read(zip, false);
                UpdatePackage.CheckVersionFrom(manifest, current);
                if (Version.Parse(manifest.version) != step.Version ||
                    (String.IsNullOrWhiteSpace(manifest.baseVersion) ? null : Version.Parse(manifest.baseVersion)) != step.BaseVersion)
                    throw new InvalidDataException("更新包版本与确认的更新路径不一致：" + step.Asset.name);
                current = manifest.version;
                completed += step.Asset.size;
            }
        }
        File.WriteAllText(Path.Combine(root, "chain.json"), new JavaScriptSerializer().Serialize(names));
    }

    private static async Task DownloadUpdateAsset(HttpClient client, OnlineUpdateStep step, string path,
        Action<long> progress, CancellationToken token)
    {
        using (var response = await client.GetAsync(step.Asset.browser_download_url, HttpCompletionOption.ResponseHeadersRead, token))
        using (token.Register(response.Dispose))
        {
            response.EnsureSuccessStatusCode();
            using (var input = await response.Content.ReadAsStreamAsync())
            using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536))
            using (var sha = SHA256.Create())
            {
                var buffer = new byte[65536];
                var clock = Stopwatch.StartNew();
                long size = 0;
                int read;
                while ((read = await input.ReadAsync(buffer, 0, buffer.Length, token)) > 0)
                {
                    size += read;
                    if (size > step.Asset.size) throw new InvalidDataException("更新包超出声明大小。");
                    output.Write(buffer, 0, read);
                    sha.TransformBlock(buffer, 0, read, buffer, 0);
                    if (clock.ElapsedMilliseconds >= 160 || size == step.Asset.size)
                    {
                        progress(size);
                        clock.Restart();
                    }
                }
                sha.TransformFinalBlock(buffer, 0, 0);
                var actual = BitConverter.ToString(sha.Hash).Replace("-", "");
                if (size != step.Asset.size || !String.Equals(actual, step.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("更新包大小或 SHA-256 校验未通过：" + step.Asset.name);
            }
        }
    }

    private static string GetUpdateString(Dictionary<string, object> request, string key)
    {
        object value;
        return request != null && request.TryGetValue(key, out value) ? value as string ?? "" : "";
    }

    private static string Quote(string path) { return "\"" + path.Replace("\"", "") + "\""; }
}
