using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

internal sealed partial class WorkspaceWindow
{
    private static readonly HttpClient translationClient = new HttpClient(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
    }) { Timeout = TimeSpan.FromSeconds(20) };
    private readonly JavaScriptSerializer translationJson = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 16 };
    private string activeTranslationId;
    private CancellationTokenSource activeTranslation;

    public sealed class TranslationSettings
    {
        public string provider { get; set; }
        public string baiduId { get; set; }
        public string baiduSecret { get; set; }
        public string azureKey { get; set; }
        public string azureRegion { get; set; }
        public string localModel { get; set; }
        public string openaiBaseUrl { get; set; }
        public string openaiKey { get; set; }
        public string openaiModel { get; set; }
        public int openaiConcurrency { get; set; }
    }

    private string TranslationSettingsPath { get { return Path.Combine(dataRoot, "translation-settings.bin"); } }

    private TranslationSettings LoadTranslationSettings()
    {
        bool recovered;
        return LoadTranslationSettings(out recovered);
    }

    private TranslationSettings LoadTranslationSettings(out bool recovered)
    {
        recovered = false;
        if (!File.Exists(TranslationSettingsPath)) return new TranslationSettings { provider = "localai", localModel = "large" };
        try
        {
            var clear = ProtectedData.Unprotect(File.ReadAllBytes(TranslationSettingsPath), null, DataProtectionScope.CurrentUser);
            var settings = translationJson.Deserialize<TranslationSettings>(Encoding.UTF8.GetString(clear));
            if (settings == null) throw new FormatException();
            return settings;
        }
        catch (CryptographicException) { recovered = true; }
        catch (ArgumentException) { recovered = true; }
        catch (InvalidOperationException) { recovered = true; }
        catch (FormatException) { recovered = true; }
        var preference = FindLocalLlmModel("tiny") != null ? "tiny" :
            FindLocalLlmModel("compact") != null ? "compact" : "large";
        return new TranslationSettings { provider = "localai", localModel = preference };
    }

    private static string ReadTranslationValue(Dictionary<string, string> request, string key)
    {
        string value;
        return request.TryGetValue(key, out value) ? (value ?? "").Trim() : "";
    }

    private void SaveTranslationSettings(Dictionary<string, string> request)
    {
        bool recovered;
        var settings = LoadTranslationSettings(out recovered);
        var provider = ReadTranslationValue(request, "provider");
        if (provider != "localai" && provider != "mymemory" && provider != "baidu" && provider != "azure" && provider != "openai")
            throw new InvalidOperationException("请选择可用的翻译源。");
        settings.provider = provider;
        if (provider == "openai")
        {
            var baseUrl = ReadTranslationValue(request, "openaiBaseUrl").TrimEnd('/');
            var key = ReadTranslationValue(request, "key");
            var model = ReadTranslationValue(request, "openaiModel");
            int concurrency;
            if (!int.TryParse(ReadTranslationValue(request, "openaiConcurrency"), out concurrency)) concurrency = 8;
            concurrency = Math.Max(1, Math.Min(16, concurrency));
            Uri parsedUri;
            if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out parsedUri) ||
                (parsedUri.Scheme != Uri.UriSchemeHttp && parsedUri.Scheme != Uri.UriSchemeHttps))
                throw new InvalidOperationException("请输入有效的 http(s) 接口地址（Base URL）。");
            if (string.IsNullOrEmpty(model) || model.Length > 120)
                throw new InvalidOperationException("请输入有效的模型名称（如 deepseek-chat）。");
            if (key.Length != 0) settings.openaiKey = key;
            if (string.IsNullOrEmpty(settings.openaiKey))
                throw new InvalidOperationException("请输入云端大模型 API 密钥。");
            settings.openaiBaseUrl = baseUrl;
            settings.openaiModel = model;
            settings.openaiConcurrency = concurrency;
        }
        if (provider == "baidu")
        {
            var appId = ReadTranslationValue(request, "appId");
            var secret = ReadTranslationValue(request, "key");
            if (appId.Length != 0) settings.baiduId = appId;
            if (secret.Length != 0) settings.baiduSecret = secret;
            if (!Regex.IsMatch(settings.baiduId ?? "", @"\A[0-9]{1,40}\z") || !ValidTranslationKey(settings.baiduSecret))
                throw new InvalidOperationException("请输入有效的百度翻译 APP ID 和密钥。");
        }
        if (provider == "azure")
        {
            var key = ReadTranslationValue(request, "key");
            if (key.Length != 0) settings.azureKey = key;
            settings.azureRegion = ReadTranslationValue(request, "region");
            if (!ValidTranslationKey(settings.azureKey) || !Regex.IsMatch(settings.azureRegion, @"\A[a-zA-Z0-9-]{0,40}\z"))
                throw new InvalidOperationException("请输入有效的微软 Translator 密钥和区域。");
        }
        settings.localModel = ReadTranslationValue(request, "localModel");
        if (settings.localModel != "large" && settings.localModel != "compact" && settings.localModel != "tiny")
            settings.localModel = "large";
        var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(translationJson.Serialize(settings)), null, DataProtectionScope.CurrentUser);
        var temporary = TranslationSettingsPath + ".new";
        File.WriteAllBytes(temporary, bytes);
        if (File.Exists(TranslationSettingsPath))
        {
            var backup = recovered ? TranslationSettingsPath + ".unreadable-" + Guid.NewGuid().ToString("N") : null;
            File.Replace(temporary, TranslationSettingsPath, backup);
        }
        else File.Move(temporary, TranslationSettingsPath);
    }

    private static bool ValidTranslationKey(string value)
    {
        return Regex.IsMatch(value ?? "", @"\A[a-zA-Z0-9_\-]{6,160}\z");
    }

    private void SendTranslationSettings(CoreWebView2 web)
    {
        bool recovered;
        var settings = LoadTranslationSettings(out recovered);
        PostWorkspaceMessage(web, new { type = "translation-settings", settings.provider,
            recovered,
            baiduConfigured = ValidTranslationKey(settings.baiduSecret), azureConfigured = ValidTranslationKey(settings.azureKey),
            openaiConfigured = !string.IsNullOrEmpty(settings.openaiKey),
            openaiBaseUrl = string.IsNullOrEmpty(settings.openaiBaseUrl) ? "https://api.deepseek.com" : settings.openaiBaseUrl,
            openaiModel = string.IsNullOrEmpty(settings.openaiModel) ? "deepseek-chat" : settings.openaiModel,
            openaiConcurrency = settings.openaiConcurrency > 0 ? settings.openaiConcurrency : 8,
            region = settings.azureRegion ?? "", localModel = String.IsNullOrEmpty(settings.localModel) ? "large" : settings.localModel,
            localConfigured = FindLocalLlmModel(settings.localModel) != null,
            localModelPath = LocalLlmModelPath(settings.localModel),
            localLargeConfigured = FindLocalLlmModel("large") != null,
            localCompactConfigured = FindLocalLlmModel("compact") != null,
            localTinyConfigured = FindLocalLlmModel("tiny") != null,
            localLargePath = LocalLlmModelPath("large"),
            localCompactPath = LocalLlmModelPath("compact"),
            localTinyPath = LocalLlmModelPath("tiny"),
            localModelKeys = new { large = LocalLlmModelCacheKey("large"), compact = LocalLlmModelCacheKey("compact"),
                tiny = LocalLlmModelCacheKey("tiny") } });
    }

    private async Task HandleTranslationCommand(CoreWebView2 web, string command)
    {
        string id = null;
        try
        {
            if (command == "translation:read") { SendTranslationSettings(web); return; }
            if (command == "translation:open-local-models") { OpenLocalLlmModelDirectory(); return; }
            if (command.StartsWith("translation:cancel:", StringComparison.Ordinal))
            {
                if (command.Substring("translation:cancel:".Length) == activeTranslationId)
                {
                    var pending = activeTranslation;
                    activeTranslation = null;
                    activeTranslationId = null;
                    if (pending != null) pending.Cancel();
                }
                return;
            }
            if (command.Length > translationJson.MaxJsonLength) return;
            var data = translationJson.Deserialize<Dictionary<string, string>>(command.Substring("translation:".Length));
            id = ReadTranslationValue(data, "id");
            Guid requestId;
            if (!Guid.TryParse(id, out requestId)) return;
            var action = ReadTranslationValue(data, "action");
            if (action == "read")
            {
                SendTranslationSettings(web);
                PostWorkspaceMessage(web, new { type = "translation-response", id });
                return;
            }
            if (action == "save")
            {
                SaveTranslationSettings(data);SendTranslationSettings(web);
                PostWorkspaceMessage(web, new { type = "translation-response", id });
                return;
            }
            if (action != "translate") throw new InvalidOperationException("翻译操作无效。");
            if (activeTranslation != null) throw new InvalidOperationException("还有翻译正在处理，请稍后重试。");
            var settings = LoadTranslationSettings();
            var provider = ReadTranslationValue(data, "provider");
            if (provider != "localai" && provider != settings.provider)
                throw new InvalidOperationException("翻译源已变化，请重新翻译。");
            settings.provider = provider;
            var source = ReadTranslationValue(data, "source");
            var target = ReadTranslationValue(data, "target");
            var text = ReadTranslationValue(data, "text");
            var context = ReadTranslationValue(data, "context");
            if (!Regex.IsMatch(source, @"\A(en|zh|de|fr)\z") || !Regex.IsMatch(target, @"\A(en|zh)\z")
                || text.Length == 0 || text.Length > 10000)
                throw new InvalidOperationException("翻译内容或语言无效。");
            using (var cancellation = new CancellationTokenSource())
            {
                activeTranslation = cancellation;
                activeTranslationId = id;
                try
                {
                    var value = await TranslateWithProvider(settings, source, target, text, context, cancellation.Token);
                    cancellation.Token.ThrowIfCancellationRequested();
                    PostWorkspaceMessage(web, new { type = "translation-response", id, value });
                }
                catch (Exception)
                {
                    if (!cancellation.IsCancellationRequested) throw;
                }
                finally
                {
                    if (activeTranslation == cancellation)
                    {
                        activeTranslation = null;
                        activeTranslationId = null;
                    }
                }
            }
        }
        catch (Exception error)
        {
            var message = error is InvalidOperationException ? error.Message : "翻译服务不可用，或本机无法读取设置。";
            PostWorkspaceMessage(web, new { type = "translation-response", id, error = message });
        }
    }

    private static string NormalizeOpenAiChatUrl(string baseUrl)
    {
        var url = (baseUrl ?? "").Trim().TrimEnd('/');
        if (url.EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase)) return url;
        if (url.EndsWith("/v1", StringComparison.OrdinalIgnoreCase) || url.EndsWith("/compatible-mode/v1", StringComparison.OrdinalIgnoreCase))
            return url + "/chat/completions";
        return url + "/v1/chat/completions";
    }

    private Dictionary<string, object> BuildOpenAiWorkerConfig(TranslationSettings settings)
    {
        if (settings == null || string.IsNullOrWhiteSpace(settings.openaiBaseUrl) ||
            string.IsNullOrWhiteSpace(settings.openaiModel) || string.IsNullOrWhiteSpace(settings.openaiKey))
            throw new InvalidOperationException("云端大模型设置不完整，请在「设置 → 翻译服务」中补全接口地址、模型名和密钥。");
        return new Dictionary<string, object>
        {
            { "baseUrl", settings.openaiBaseUrl },
            { "apiKey", settings.openaiKey },
            { "model", settings.openaiModel },
            { "concurrency", settings.openaiConcurrency > 0 ? settings.openaiConcurrency : 8 }
        };
    }

    private async Task<string> TranslateWithProvider(TranslationSettings settings, string source, string target, string text, string context, CancellationToken cancellation)
    {
        HttpRequestMessage request;
        if (settings.provider == "localai")
        {
            return await TranslateWithLocalLlm(source, target, text, context, settings.localModel, cancellation);
        }
        if (settings.provider == "openai")
        {
            var cfg = BuildOpenAiWorkerConfig(settings);
            var endpoint = NormalizeOpenAiChatUrl((string)cfg["baseUrl"]);
            var targetName = target == "zh" ? "简体中文" : "English";
            var extra = (context ?? "").Replace(text, "").Trim();
            var userPrompt = "把以下原文翻译成" + targetName + "，只输出译文。保留数字、单位、公式和缩写。"
                + (string.IsNullOrEmpty(extra) ? "" : "\n术语参考（仅供理解）：" + (extra.Length > 2400 ? extra.Substring(0, 2400) : extra))
                + "\n原文：\n" + text;
            request = new HttpRequestMessage(HttpMethod.Post, endpoint);
            request.Headers.Add("Authorization", "Bearer " + (string)cfg["apiKey"]);
            request.Content = new StringContent(translationJson.Serialize(new
            {
                model = (string)cfg["model"],
                messages = new[]
                {
                    new { role = "system", content = "你是专业学术论文英译中译者。只输出准确译文，不解释。" },
                    new { role = "user", content = userPrompt }
                },
                temperature = 0.1,
                stream = false
            }), Encoding.UTF8, "application/json");
        }
        else if (settings.provider == "baidu")
        {
            if (Encoding.UTF8.GetByteCount(text) > 1000 || !ValidTranslationKey(settings.baiduSecret))
                throw new InvalidOperationException("请检查百度翻译凭证或缩短原文。");
            var salt = Guid.NewGuid().ToString("N");
            string sign;
            using (var md5 = MD5.Create())
                sign = BitConverter.ToString(md5.ComputeHash(Encoding.UTF8.GetBytes(settings.baiduId + text + salt + settings.baiduSecret))).Replace("-", "").ToLowerInvariant();
            request = new HttpRequestMessage(HttpMethod.Post, "https://fanyi-api.baidu.com/api/trans/vip/translate");
            request.Content = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                {"q", text}, {"from", source == "fr" ? "fra" : source}, {"to", target},
                {"appid", settings.baiduId}, {"salt", salt}, {"sign", sign}
            });
        }
        else if (settings.provider == "azure" && ValidTranslationKey(settings.azureKey))
        {
            request = new HttpRequestMessage(HttpMethod.Post, "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from="
                + (source == "zh" ? "zh-Hans" : source) + "&to=" + (target == "zh" ? "zh-Hans" : target));
            request.Headers.Add("Ocp-Apim-Subscription-Key", settings.azureKey);
            if (!string.IsNullOrEmpty(settings.azureRegion)) request.Headers.Add("Ocp-Apim-Subscription-Region", settings.azureRegion);
            request.Content = new StringContent(translationJson.Serialize(new[] { new { Text = text } }), Encoding.UTF8, "application/json");
        }
        else throw new InvalidOperationException("请先在设置中配置翻译源。");

        using (request)
        using (var response = await translationClient.SendAsync(request, cancellation))
        {
            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException("翻译服务返回 HTTP " + (int)response.StatusCode + "，请检查凭证、区域或额度。");
            var jsonValue = translationJson.DeserializeObject(await response.Content.ReadAsStringAsync());
            if (settings.provider == "openai")
            {
                var root = (Dictionary<string, object>)jsonValue;
                var choices = root["choices"] as object[];
                if (choices == null || choices.Length == 0) throw new InvalidOperationException("云端模型未返回有效译文。");
                var message = (Dictionary<string, object>)((Dictionary<string, object>)choices[0])["message"];
                return Convert.ToString(message["content"]).Trim();
            }
            var rows = jsonValue as object[];
            if (settings.provider == "baidu")
            {
                var data = (Dictionary<string, object>)jsonValue;
                object result;
                if (!data.TryGetValue("trans_result", out result))
                {
                    object code;data.TryGetValue("error_code", out code);
                    string status = Convert.ToString(code);
                    throw new InvalidOperationException("百度翻译未返回译文" + (Regex.IsMatch(status, @"\A\d{1,8}\z") ? "（" + status + "）" : "") + "，请检查凭证或额度。");
                }
                var translated = new List<string>();
                foreach (Dictionary<string, object> row in (object[])result) translated.Add((string)row["dst"]);
                return string.Join("\n", translated);
            }
            var entries = (object[])((Dictionary<string, object>)rows[0])["translations"];
            return (string)((Dictionary<string, object>)entries[0])["text"];
        }
    }
}
