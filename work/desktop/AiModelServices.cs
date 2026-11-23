using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

internal sealed class AiModelServiceConfig
{
    public string baseUrl { get; set; }
    public string model { get; set; }
    public string key { get; set; }
}

internal sealed partial class WorkspaceWindow
{
    private sealed class AiModelMessage
    {
        public string type { get; set; }
        public string id { get; set; }
        public string profileId { get; set; }
        public string action { get; set; }
        public AiModelServiceConfig config { get; set; }
    }

    private static readonly byte[] ModelCredentialEntropy = Encoding.UTF8.GetBytes("DoNote.AiModelService.v1");

    private bool HandleAiModelMessage(CoreWebView2 web, string source)
    {
        if (source.Length > 16000 || source.IndexOf("donote-ai-model", StringComparison.Ordinal) < 0) return false;
        var serializer = new JavaScriptSerializer { MaxJsonLength = 16000, RecursionLimit = 8 };
        AiModelMessage request;
        try { request = serializer.Deserialize<AiModelMessage>(source); }
        catch (ArgumentException) { return false; }
        Guid id, profile;
        if (request == null || request.type != "donote-ai-model") return false;
        if (!Guid.TryParse(request.id, out id) || !Guid.TryParse(request.profileId, out profile)) return true;
        try
        {
            string folder = Path.Combine(dataRoot, "AiModelServices");
            string path = Path.Combine(folder, profile.ToString("D") + ".bin");
            AiModelServiceConfig config;
            if (request.action == "save")
            {
                config = request.config;
                ValidateAiModelConfig(config);
                byte[] bytes = Encoding.UTF8.GetBytes(serializer.Serialize(config));
                byte[] encrypted = ProtectedData.Protect(bytes, ModelCredentialEntropy, DataProtectionScope.CurrentUser);
                Directory.CreateDirectory(folder);
                string pending = path + ".new";
                File.WriteAllBytes(pending, encrypted);
                if (File.Exists(path)) File.Replace(pending, path, null);
                else File.Move(pending, path);
            }
            else if (request.action == "read")
            {
                config = null;
                if (File.Exists(path))
                {
                    byte[] bytes = ProtectedData.Unprotect(File.ReadAllBytes(path), ModelCredentialEntropy, DataProtectionScope.CurrentUser);
                    config = serializer.Deserialize<AiModelServiceConfig>(Encoding.UTF8.GetString(bytes));
                    ValidateAiModelConfig(config);
                }
            }
            else return true;
            PostWorkspaceMessage(web, new { type = "donote-ai-model-result", id = request.id, config });
        }
        catch (Exception error)
        {
            PostWorkspaceMessage(web, new { type = "donote-ai-model-result", id = request.id,
                error = error is InvalidDataException ? error.Message : "无法读取或保存本机模型设置。" });
        }
        return true;
    }

    private static void ValidateAiModelConfig(AiModelServiceConfig config)
    {
        Uri address;
        if (config == null || String.IsNullOrWhiteSpace(config.baseUrl) || config.baseUrl.Length > 2048 ||
            !Uri.TryCreate(config.baseUrl, UriKind.Absolute, out address) ||
            (address.Scheme != "https" && (address.Scheme != "http" || !address.IsLoopback)) ||
            address.UserInfo.Length != 0 || address.Query.Length != 0 || address.Fragment.Length != 0 ||
            String.IsNullOrWhiteSpace(config.model) || config.model.Length > 200 ||
            config.key == null || config.key.Length > 4096 || config.key.IndexOfAny(new[] { '\r', '\n' }) >= 0)
            throw new InvalidDataException("AI 服务地址、模型名称或密钥格式无效。");
    }
}
