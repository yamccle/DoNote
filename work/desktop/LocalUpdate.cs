/*
 * [INPUT]: 接收本地 ZIP 更新请求或 WebView2 在线检查/下载 GitHub Releases 消息。
 * [OUTPUT]: 查询 GitHub 最新正式版、优先匹配增量补丁、流式校验 SHA-256 下载并移交 DoNoteUpdater.exe。
 * [POS]: 桌面端本地与在线自动更新入口，严格保护用户 Data/ 与 models/ 目录。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
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
    private string verifiedDownloadedZip;

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

    private void LaunchUpdaterAndExit(string packageZipPath, string installDirectory)
    {
        var helper = Path.Combine(installDirectory, "DoNoteUpdater.exe");
        if (!File.Exists(helper)) throw new FileNotFoundException("当前版本没有更新助手，请先覆盖安装支持更新的版本。");
        var temporary = Path.Combine(Path.GetTempPath(), "DoNote-Update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporary);
        var copiedHelper = Path.Combine(temporary, "DoNoteUpdater.exe");
        File.Copy(helper, copiedHelper);
        Process.Start(new ProcessStartInfo(copiedHelper)
        {
            Arguments = Quote(packageZipPath) + " " + Quote(installDirectory) + " " + Quote(dataRoot) + " " + Process.GetCurrentProcess().Id,
            UseShellExecute = false,
            WorkingDirectory = temporary
        });
        CloseWithoutExitPrompt();
    }

    private async void BeginLocalUpdate()
    {
        if (updateChecking) return;
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
            cts.Dispose();
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
        if (requestJson.Length > 32768 || requestJson.IndexOf("\"online-update\"", StringComparison.Ordinal) < 0)
            return false;
        Dictionary<string, object> req;
        try
        {
            req = new JavaScriptSerializer { MaxJsonLength = 32768, RecursionLimit = 6 }.Deserialize<Dictionary<string, object>>(requestJson);
        }
        catch { return false; }

        object typeObj, actionObj, idObj;
        if (req == null || !req.TryGetValue("type", out typeObj) || (typeObj as string) != "online-update")
            return false;
        req.TryGetValue("action", out actionObj);
        req.TryGetValue("id", out idObj);
        string action = actionObj as string ?? "";
        string id = idObj as string ?? "";
        string installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);

        if (action == "cancel")
        {
            StopOnlineUpdateDownload();
            PostWorkspaceMessage(web, new { type = "online-update-result", id = id, cancelled = true });
            return true;
        }
        if (action == "apply-downloaded")
        {
            try
            {
                if (string.IsNullOrWhiteSpace(verifiedDownloadedZip) || !File.Exists(verifiedDownloadedZip))
                    throw new InvalidOperationException("未找到已校验的更新包，请重新下载。");
                var manifest = UpdatePackage.Read(verifiedDownloadedZip, false);
                UpdatePackage.CheckVersion(manifest, installDir);
                LaunchUpdaterAndExit(verifiedDownloadedZip, installDir);
            }
            catch (Exception error)
            {
                PostWorkspaceMessage(web, new { type = "online-update-result", id = id, error = error.Message });
            }
            return true;
        }
        if (action == "check")
        {
            try
            {
                string currentVersion = ReadInstalledVersion(installDir);
                string feedUrl = Environment.GetEnvironmentVariable("DONOTE_UPDATE_FEED_URL");
                if (string.IsNullOrWhiteSpace(feedUrl)) feedUrl = DefaultReleaseApiUrl;

                using (var client = CreateUpdateHttpClient(TimeSpan.FromSeconds(25)))
                {
                    string payload = await client.GetStringAsync(feedUrl);
                    var serializer = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
                    var rel = serializer.Deserialize<Dictionary<string, object>>(payload);
                    string tag = GetStr(rel, "tag_name");
                    string relName = GetStr(rel, "name");
                    string body = GetStr(rel, "body");
                    string htmlUrl = GetStr(rel, "html_url");
                    var assetsRaw = rel.ContainsKey("assets") ? rel["assets"] as System.Collections.ArrayList : null;

                    string remoteVersion = "";
                    var m = Regex.Match(relName + " " + body, @"\b(26\.\d+\.\d+)\b");
                    if (m.Success) remoteVersion = m.Groups[1].Value;

                    string patchName = "DoNote-Update-" + currentVersion + "-to-" + tag + ".zip";
                    string fullName = "DoNote-Windows-x64-" + tag + ".zip";
                    string metaName = "DoNote-" + tag + "-release.json";
                    Dictionary<string, object> patchAsset = null, fullAsset = null, metaAsset = null;

                    if (assetsRaw != null)
                    {
                        foreach (object item in assetsRaw)
                        {
                            var asset = item as Dictionary<string, object>;
                            if (asset == null) continue;
                            string aName = GetStr(asset, "name");
                            if (string.Equals(aName, patchName, StringComparison.OrdinalIgnoreCase)) patchAsset = asset;
                            else if (string.Equals(aName, fullName, StringComparison.OrdinalIgnoreCase)) fullAsset = asset;
                            else if (string.Equals(aName, metaName, StringComparison.OrdinalIgnoreCase)) metaAsset = asset;
                        }
                    }

                    var metaShas = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    if (metaAsset != null)
                    {
                        string metaUrl = GetStr(metaAsset, "browser_download_url");
                        if (IsAllowedUpdateUrl(metaUrl))
                        {
                            try
                            {
                                string metaText = await client.GetStringAsync(metaUrl);
                                var metaObj = serializer.Deserialize<Dictionary<string, object>>(metaText);
                                string v = GetStr(metaObj, "version");
                                if (!string.IsNullOrWhiteSpace(v)) remoteVersion = v;
                                var arts = metaObj.ContainsKey("artifacts") ? metaObj["artifacts"] as System.Collections.ArrayList : null;
                                if (arts != null)
                                {
                                    foreach (object a in arts)
                                    {
                                        var d = a as Dictionary<string, object>;
                                        if (d != null && !string.IsNullOrWhiteSpace(GetStr(d, "name")) && !string.IsNullOrWhiteSpace(GetStr(d, "sha256")))
                                            metaShas[GetStr(d, "name")] = GetStr(d, "sha256");
                                    }
                                }
                            }
                            catch { }
                        }
                    }

                    Version curVer, remVer;
                    if (!Version.TryParse(currentVersion, out curVer)) curVer = new Version("26.1105.0001");
                    if (!Version.TryParse(remoteVersion, out remVer) || remVer <= curVer)
                    {
                        PostWorkspaceMessage(web, new
                        {
                            type = "online-update-result",
                            id = id,
                            hasUpdate = false,
                            currentVersion = currentVersion,
                            remoteVersion = string.IsNullOrWhiteSpace(remoteVersion) ? currentVersion : remoteVersion,
                            tag = tag,
                            htmlUrl = htmlUrl
                        });
                        return true;
                    }

                    var chosen = patchAsset ?? fullAsset;
                    if (chosen == null)
                        throw new InvalidOperationException("GitHub 最新版本（" + tag + "）尚未上传可识别的桌面更新包。");

                    string chosenName = GetStr(chosen, "name");
                    string chosenUrl = GetStr(chosen, "browser_download_url");
                    long chosenSize = GetLong(chosen, "size");
                    string digestField = GetStr(chosen, "digest");
                    string sha = "";
                    if (digestField.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
                        sha = digestField.Substring(7).Trim();
                    else if (metaShas.ContainsKey(chosenName))
                        sha = metaShas[chosenName];

                    PostWorkspaceMessage(web, new
                    {
                        type = "online-update-result",
                        id = id,
                        hasUpdate = true,
                        currentVersion = currentVersion,
                        remoteVersion = remoteVersion,
                        tag = tag,
                        releaseNotes = body.Length > 2400 ? body.Substring(0, 2400) + "…" : body,
                        downloadMode = patchAsset != null ? "patch" : "full",
                        assetName = chosenName,
                        assetSize = chosenSize,
                        assetUrl = chosenUrl,
                        assetSha256 = sha,
                        htmlUrl = htmlUrl
                    });
                }
            }
            catch (Exception error)
            {
                PostWorkspaceMessage(web, new { type = "online-update-result", id = id, error = "检查更新失败：" + error.Message });
            }
            return true;
        }
        if (action == "download")
        {
            string url = GetStr(req, "assetUrl");
            string fileName = Path.GetFileName(GetStr(req, "assetName"));
            string expectedSha = GetStr(req, "assetSha256").Trim();
            long expectedSize = GetLong(req, "assetSize");

            if (!IsAllowedUpdateUrl(url) || string.IsNullOrWhiteSpace(fileName) || !fileName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            {
                PostWorkspaceMessage(web, new { type = "online-update-result", id = id, error = "更新包下载地址不受信任。" });
                return true;
            }
            StopOnlineUpdateDownload();
            var cts = new CancellationTokenSource();
            onlineUpdateCancel = cts;
            string cacheDir = Path.Combine(Path.GetTempPath(), "DoNote-AutoUpdate");
            Directory.CreateDirectory(cacheDir);
            string targetZip = Path.Combine(cacheDir, fileName);
            string tempPart = targetZip + ".part";

            try
            {
                await Task.Run(async () =>
                {
                    using (var client = CreateUpdateHttpClient(TimeSpan.FromMinutes(30)))
                    using (var resp = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cts.Token))
                    {
                        resp.EnsureSuccessStatusCode();
                        long total = resp.Content.Headers.ContentLength ?? expectedSize;
                        using (var netStream = await resp.Content.ReadAsStreamAsync())
                        using (var outStream = new FileStream(tempPart, FileMode.Create, FileAccess.Write, FileShare.None, 65536))
                        using (var sha = SHA256.Create())
                        {
                            byte[] buffer = new byte[65536];
                            long received = 0;
                            var clock = Stopwatch.StartNew();
                            long lastTick = 0;
                            int read;
                            while ((read = await netStream.ReadAsync(buffer, 0, buffer.Length, cts.Token)) > 0)
                            {
                                outStream.Write(buffer, 0, read);
                                sha.TransformBlock(buffer, 0, read, buffer, 0);
                                received += read;
                                if (clock.ElapsedMilliseconds - lastTick >= 160 || (total > 0 && received >= total))
                                {
                                    lastTick = clock.ElapsedMilliseconds;
                                    int pct = total > 0 ? (int)Math.Min(100, (received * 100L) / total) : 0;
                                    BeginInvoke((Action)(() =>
                                    {
                                        PostWorkspaceMessage(web, new
                                        {
                                            type = "online-update-progress",
                                            id = id,
                                            assetName = fileName,
                                            received = received,
                                            total = total,
                                            percent = pct
                                        });
                                    }));
                                }
                            }
                            sha.TransformFinalBlock(buffer, 0, 0);
                            string actualSha = BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
                            if (expectedSize > 0 && received != expectedSize)
                                throw new InvalidDataException("下载字节数不完整（" + received + " / " + expectedSize + "）。");
                            if (!string.IsNullOrWhiteSpace(expectedSha) && !string.Equals(actualSha, expectedSha, StringComparison.OrdinalIgnoreCase))
                                throw new InvalidDataException("更新包 SHA-256 校验未通过，已拦截安装。");
                        }
                    }
                    if (File.Exists(targetZip)) File.Delete(targetZip);
                    File.Move(tempPart, targetZip);
                    var manifest = UpdatePackage.Read(targetZip, false);
                    UpdatePackage.CheckVersion(manifest, installDir);
                    verifiedDownloadedZip = targetZip;
                    BeginInvoke((Action)(() =>
                    {
                        PostWorkspaceMessage(web, new
                        {
                            type = "online-update-result",
                            id = id,
                            downloaded = true,
                            targetVersion = manifest.version,
                            isPatch = !string.IsNullOrWhiteSpace(manifest.baseVersion),
                            assetName = fileName
                        });
                    }));
                }, cts.Token);
            }
            catch (OperationCanceledException)
            {
                try { if (File.Exists(tempPart)) File.Delete(tempPart); } catch { }
                PostWorkspaceMessage(web, new { type = "online-update-result", id = id, cancelled = true });
            }
            catch (Exception error)
            {
                try { if (File.Exists(tempPart)) File.Delete(tempPart); } catch { }
                PostWorkspaceMessage(web, new { type = "online-update-result", id = id, error = "下载或校验失败：" + error.Message });
            }
            finally
            {
                if (onlineUpdateCancel == cts) onlineUpdateCancel = null;
                cts.Dispose();
            }
            return true;
        }
        return true;
    }

    private static string GetStr(Dictionary<string, object> dict, string key)
    {
        object val;
        return dict != null && dict.TryGetValue(key, out val) && val != null ? Convert.ToString(val) : "";
    }

    private static long GetLong(Dictionary<string, object> dict, string key)
    {
        object val;
        if (dict == null || !dict.TryGetValue(key, out val) || val == null) return 0;
        long parsed;
        return long.TryParse(Convert.ToString(val), out parsed) ? parsed : 0;
    }

    private static string Quote(string path) { return "\"" + path.Replace("\"", "") + "\""; }
}
