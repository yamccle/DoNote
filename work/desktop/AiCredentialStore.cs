using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

internal sealed class StoredAiCredential
{
    public string profileId { get; set; }
    public string kind { get; set; }
    public string baseUrl { get; set; }
    public string adminToken { get; set; }
}

internal sealed class AiCredentialStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("DoNote.AiConnection.v1");
    private readonly string dataRoot;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();

    internal AiCredentialStore(string dataRoot) { this.dataRoot = dataRoot; }

    private string PathFor(string profileId)
    {
        if (string.IsNullOrWhiteSpace(profileId) || profileId.Length > 128) throw new InvalidDataException("用户 ID 无效。");
        byte[] digest;
        using (var sha = SHA256.Create()) digest = sha.ComputeHash(Encoding.UTF8.GetBytes(profileId));
        return Path.Combine(dataRoot, "AiConnections", BitConverter.ToString(digest).Replace("-", "") + ".bin");
    }

    internal static void ValidateRemote(string baseUrl, string token)
    {
        Uri uri;
        if (string.IsNullOrWhiteSpace(baseUrl) || baseUrl.Length > 2048 ||
            !Uri.TryCreate(baseUrl, UriKind.Absolute, out uri) ||
            (uri.Scheme != "https" && (uri.Scheme != "http" ||
            (uri.Host != "127.0.0.1" && uri.Host != "localhost" && uri.Host != "[::1]"))) ||
            uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0 ||
            string.IsNullOrWhiteSpace(token) || token.Length < 24 || token.Length > 2048 || token.IndexOfAny(new[] { '\r', '\n' }) >= 0)
            throw new InvalidDataException("AI 服务地址或管理令牌无效。");
    }

    internal void Save(StoredAiCredential stored)
    {
        if (stored == null || (stored.kind != "local" && stored.kind != "remote")) throw new InvalidDataException("连接类型无效。");
        if (stored.kind == "remote") ValidateRemote(stored.baseUrl, stored.adminToken);
        else { stored.baseUrl = null; stored.adminToken = null; }
        var path = PathFor(stored.profileId);
        var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(json.Serialize(stored)), Entropy, DataProtectionScope.CurrentUser);
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        var pending = path + ".pending";
        File.WriteAllBytes(pending, encrypted);
        if (File.Exists(path)) File.Replace(pending, path, null);
        else File.Move(pending, path);
    }

    internal StoredAiCredential Read(string profileId)
    {
        var path = PathFor(profileId);
        if (!File.Exists(path)) return null;
        var bytes = ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.CurrentUser);
        var saved = json.Deserialize<StoredAiCredential>(Encoding.UTF8.GetString(bytes));
        if (saved == null || saved.profileId != profileId || (saved.kind != "local" && saved.kind != "remote")) throw new InvalidDataException("保存的 AI 凭证与当前用户不匹配或已损坏。");
        if (saved.kind == "remote") ValidateRemote(saved.baseUrl, saved.adminToken);
        return saved;
    }

    internal void Forget(string profileId)
    {
        var path = PathFor(profileId);
        if (File.Exists(path)) File.Delete(path);
    }
}
