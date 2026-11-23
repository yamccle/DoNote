using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

internal sealed class AiCredentialRequest
{
    public string type { get; set; }
    public string action { get; set; }
    public string profileId { get; set; }
    public string kind { get; set; }
    public string baseUrl { get; set; }
    public string adminToken { get; set; }
}

internal sealed partial class WorkspaceWindow
{
    private static readonly Version RequiredLocalBridgeVersion = new Version(1, 3, 0);

    private sealed class LocalBridgeHealth
    {
        public string service { get; set; }
        public string version { get; set; }
    }

    private async Task<BridgeConnection> TryReuseLocalBridge(string runtime, int port, string executable)
    {
        try
        {
            var connectionPath = Path.Combine(runtime, "connection.json");
            var ownerPath = Path.Combine(runtime, "owner.secret");
            if (!File.Exists(connectionPath) || !File.Exists(ownerPath)) return null;
            var saved = json.Deserialize<BridgeConnection>(File.ReadAllText(connectionPath));
            Uri address;
            if (saved == null || saved.pid <= 0 ||
                !Uri.TryCreate(saved.baseUrl, UriKind.Absolute, out address) ||
                address.Scheme != "http" || address.Host != "127.0.0.1" ||
                address.AbsolutePath != "/" || address.UserInfo.Length != 0 ||
                address.Query.Length != 0 || address.Fragment.Length != 0 ||
                (port != 0 && address.Port != port) ||
                string.IsNullOrWhiteSpace(saved.adminToken) ||
                saved.adminToken != File.ReadAllText(ownerPath).Trim()) return null;
            using (var process = Process.GetProcessById(saved.pid))
            using (var handler = new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
            using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(3) })
            using (var request = new HttpRequestMessage(HttpMethod.Get, saved.baseUrl.TrimEnd('/') + "/api/admin/profiles"))
            {
                if (process.HasExited ||
                    !String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase) ||
                    process.StartTime.ToUniversalTime() > File.GetLastWriteTimeUtc(connectionPath).AddSeconds(1)) return null;

                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", saved.adminToken);
                using (var response = await client.SendAsync(request))
                    if (!response.IsSuccessStatusCode) return null;

                LocalBridgeHealth health;
                using (var response = await client.GetAsync(saved.baseUrl.TrimEnd('/') + "/health"))
                {
                    if (!response.IsSuccessStatusCode) return null;
                    health = json.Deserialize<LocalBridgeHealth>(await response.Content.ReadAsStringAsync());
                }
                Version version;
                if (health == null || health.service != "analog-notes-ai-bridge" ||
                    !Version.TryParse(health.version, out version)) return null;
                if (version >= RequiredLocalBridgeVersion) return saved;

                // The on-disk executable, saved owner identity and connection timestamp match
                // this installation. Stop the outdated process so the new one can reuse its data.
                try
                {
                    if (!process.HasExited)
                    {
                        process.Kill();
                        if (!await Task.Run(() => process.WaitForExit(5000)))
                            throw new IOException("旧版本机 AI 服务未能退出，请重启电脑后再连接。");
                    }
                }
                catch (InvalidOperationException) { if (!process.HasExited) throw; }
                return null;
            }
        }
        catch (IOException) { throw; }
        catch { return null; }
    }

    private async Task<bool> HandleAiCredentialMessage(CoreWebView2 web, string source)
    {
        if (source.Length > 8192 || source.IndexOf("yams-one-ai-credential", StringComparison.Ordinal) < 0) return false;
        AiCredentialRequest request;
        try { request = json.Deserialize<AiCredentialRequest>(source); }
        catch { return false; }
        if (request == null || request.type != "yams-one-ai-credential") return false;
        try
        {
            var store = new AiCredentialStore(dataRoot);
            if (request.action == "forget")
            {
                store.Forget(request.profileId);
            }
            else if (request.action == "save")
            {
                store.Save(new StoredAiCredential
                {
                    profileId = request.profileId,
                    kind = request.kind,
                    baseUrl = request.baseUrl,
                    adminToken = request.adminToken
                });
            }
            else if (request.action == "restore")
            {
                var saved = store.Read(request.profileId);
                if (saved == null)
                {
                    PostWorkspaceMessage(web, new { type = "yams-one-ai-restore", profileId = request.profileId, missing = true });
                    return true;
                }
                if (saved.kind == "local")
                {
                    var connection = await StartLocalBridge();
                    PostWorkspaceMessage(web, new { type = "yams-one-ai-restore", profileId = request.profileId, kind = "local", baseUrl = connection.baseUrl, adminToken = connection.adminToken });
                }
                else if (saved.kind == "remote")
                {
                    PostWorkspaceMessage(web, new { type = "yams-one-ai-restore", profileId = request.profileId, kind = "remote", baseUrl = saved.baseUrl, adminToken = saved.adminToken });
                }
                else throw new InvalidDataException("保存的 AI 连接类型无效。");
            }
            else throw new InvalidDataException("不支持的 AI 凭证操作。");
        }
        catch (Exception error)
        {
            PostWorkspaceMessage(web, new { type = request.action == "restore" ? "yams-one-ai-restore" : "yams-one-ai-persistence", profileId = request.profileId, error = error.Message });
        }
        return true;
    }
}
