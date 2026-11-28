/**
 * [INPUT]: 读取本机 DPAPI 加密的 ai-hub-settings.bin，兼容自动迁移旧版 translation-settings.bin 与 AiModelServices/*.bin。
 * [OUTPUT]: 提供统一 AI 服务商凭证库增删改查、掩码回显、实测连通性、四类场景模型路由解析及翻译设置双向同步。
 * [POS]: WorkspaceWindow 统一 AI 服务商中心分部类，消除翻译与 PDF/视频问答重复填密钥的历史割裂。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

internal sealed class AiModelServiceConfig
{
    public string baseUrl { get; set; }
    public string model { get; set; }
    public string key { get; set; }
}

internal sealed class AiProviderEntry
{
    public string id { get; set; }
    public string name { get; set; }
    public string baseUrl { get; set; }
    public string apiKey { get; set; }
    public string defaultModel { get; set; }
}

internal sealed class AiScenarioBinding
{
    public string providerId { get; set; }
    public string model { get; set; }
}

internal sealed class AiHubSettings
{
    public List<AiProviderEntry> providers { get; set; }
    public string primaryProviderId { get; set; }
    public string translateMode { get; set; }
    public string translateProviderId { get; set; }
    public string translateModel { get; set; }
    public int translateConcurrency { get; set; }
    public string localModel { get; set; }
    public string baiduId { get; set; }
    public string baiduSecret { get; set; }
    public string azureKey { get; set; }
    public string azureRegion { get; set; }
    public AiScenarioBinding reader { get; set; }
    public AiScenarioBinding vision { get; set; }
    public AiScenarioBinding subtitle { get; set; }
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
    private static readonly byte[] AiHubEntropy = Encoding.UTF8.GetBytes("DoNote.AiHub.v1");
    private readonly JavaScriptSerializer aiHubJson = new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 16 };

    private string AiHubSettingsPath { get { return Path.Combine(dataRoot, "ai-hub-settings.bin"); } }

    private static string InferProviderDisplayName(string baseUrl)
    {
        var lower = (baseUrl ?? "").ToLowerInvariant();
        if (lower.Contains("deepseek.com")) return "DeepSeek";
        if (lower.Contains("aliyuncs.com") || lower.Contains("dashscope")) return "通义千问 · 百炼";
        if (lower.Contains("siliconflow")) return "硅基流动 SiliconFlow";
        if (lower.Contains("openrouter.ai")) return "OpenRouter";
        if (lower.Contains("moonshot.cn")) return "月之暗面 Kimi";
        if (lower.Contains("bigmodel.cn")) return "智谱 GLM";
        if (lower.Contains("volces.com") || lower.Contains("ark.")) return "火山方舟 · 豆包";
        if (lower.Contains("openai.com")) return "OpenAI";
        if (lower.Contains("127.0.0.1") || lower.Contains("localhost") || lower.Contains("[::1]")) return "本机服务 (Ollama / vLLM)";
        Uri parsed;
        if (Uri.TryCreate(baseUrl, UriKind.Absolute, out parsed) && !string.IsNullOrEmpty(parsed.Host))
            return parsed.Host;
        return "OpenAI 兼容服务";
    }

    private static string MaskSecretKey(string raw)
    {
        var key = (raw ?? "").Trim();
        if (string.IsNullOrEmpty(key) || key == "local") return "";
        if (key.Length <= 8) return "••••••••";
        var prefixLen = key.StartsWith("sk-", StringComparison.OrdinalIgnoreCase) ? 5 : 3;
        return key.Substring(0, prefixLen) + "••••" + key.Substring(key.Length - 4);
    }

    private AiHubSettings NormalizeAiHubSettings(AiHubSettings hub)
    {
        if (hub == null) hub = new AiHubSettings();
        if (hub.providers == null) hub.providers = new List<AiProviderEntry>();
        var cleaned = new List<AiProviderEntry>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in hub.providers)
        {
            if (item == null || string.IsNullOrWhiteSpace(item.baseUrl)) continue;
            if (string.IsNullOrWhiteSpace(item.id)) item.id = "prov-" + Guid.NewGuid().ToString("N").Substring(0, 10);
            if (!seen.Add(item.id)) continue;
            item.baseUrl = item.baseUrl.Trim().TrimEnd('/');
            item.name = string.IsNullOrWhiteSpace(item.name) ? InferProviderDisplayName(item.baseUrl) : item.name.Trim();
            item.defaultModel = (item.defaultModel ?? "").Trim();
            item.apiKey = NormalizeApiKeyInput(item.apiKey);
            cleaned.Add(item);
        }
        hub.providers = cleaned;
        if (cleaned.Count == 0)
        {
            hub.primaryProviderId = "";
        }
        else if (FindProviderById(cleaned, hub.primaryProviderId) == null)
        {
            hub.primaryProviderId = cleaned[0].id;
        }
        if (hub.translateMode != "cloud" && hub.translateMode != "localai" && hub.translateMode != "mymemory" &&
            hub.translateMode != "baidu" && hub.translateMode != "azure")
        {
            hub.translateMode = cleaned.Count > 0 ? "cloud" : "localai";
        }
        if (hub.translateConcurrency < 1 || hub.translateConcurrency > 16) hub.translateConcurrency = 8;
        if (hub.localModel != "large" && hub.localModel != "compact" && hub.localModel != "tiny")
        {
            hub.localModel = FindLocalLlmModel("tiny") != null ? "tiny" :
                FindLocalLlmModel("compact") != null ? "compact" : "large";
        }
        if (hub.reader == null) hub.reader = new AiScenarioBinding { providerId = "", model = "" };
        if (hub.vision == null) hub.vision = new AiScenarioBinding { providerId = "", model = "" };
        if (hub.subtitle == null) hub.subtitle = new AiScenarioBinding { providerId = "", model = "" };
        hub.translateProviderId = (hub.translateProviderId ?? "").Trim();
        hub.translateModel = (hub.translateModel ?? "").Trim();
        hub.reader.providerId = (hub.reader.providerId ?? "").Trim();
        hub.reader.model = (hub.reader.model ?? "").Trim();
        hub.vision.providerId = (hub.vision.providerId ?? "").Trim();
        hub.vision.model = (hub.vision.model ?? "").Trim();
        hub.subtitle.providerId = (hub.subtitle.providerId ?? "").Trim();
        hub.subtitle.model = (hub.subtitle.model ?? "").Trim();
        return hub;
    }

    private static AiProviderEntry FindProviderById(List<AiProviderEntry> list, string id)
    {
        if (list == null || string.IsNullOrEmpty(id)) return null;
        for (int i = 0; i < list.Count; i++)
        {
            if (string.Equals(list[i].id, id, StringComparison.Ordinal)) return list[i];
        }
        return null;
    }

    private AiHubSettings MigrateLegacySettingsToHub()
    {
        bool recovered;
        var legacyTrans = LoadTranslationSettingsRaw(out recovered);
        var hub = new AiHubSettings
        {
            providers = new List<AiProviderEntry>(),
            translateMode = legacyTrans.provider == "openai" ? "cloud" : (legacyTrans.provider ?? "localai"),
            translateConcurrency = legacyTrans.openaiConcurrency > 0 ? legacyTrans.openaiConcurrency : 8,
            localModel = string.IsNullOrEmpty(legacyTrans.localModel) ? "large" : legacyTrans.localModel,
            baiduId = legacyTrans.baiduId ?? "",
            baiduSecret = legacyTrans.baiduSecret ?? "",
            azureKey = legacyTrans.azureKey ?? "",
            azureRegion = legacyTrans.azureRegion ?? "",
            reader = new AiScenarioBinding { providerId = "", model = "" },
            vision = new AiScenarioBinding { providerId = "", model = "" },
            subtitle = new AiScenarioBinding { providerId = "", model = "" }
        };

        if (!string.IsNullOrWhiteSpace(legacyTrans.openaiBaseUrl) && !string.IsNullOrWhiteSpace(legacyTrans.openaiKey))
        {
            var p1 = new AiProviderEntry
            {
                id = "prov-" + Guid.NewGuid().ToString("N").Substring(0, 10),
                name = InferProviderDisplayName(legacyTrans.openaiBaseUrl),
                baseUrl = legacyTrans.openaiBaseUrl.Trim().TrimEnd('/'),
                apiKey = NormalizeApiKeyInput(legacyTrans.openaiKey),
                defaultModel = string.IsNullOrWhiteSpace(legacyTrans.openaiModel) ? "deepseek-chat" : legacyTrans.openaiModel.Trim()
            };
            hub.providers.Add(p1);
            hub.primaryProviderId = p1.id;
            hub.translateProviderId = p1.id;
        }

        var legacyDir = Path.Combine(dataRoot, "AiModelServices");
        if (Directory.Exists(legacyDir))
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 16000, RecursionLimit = 8 };
            foreach (var file in Directory.GetFiles(legacyDir, "*.bin"))
            {
                try
                {
                    var clear = ProtectedData.Unprotect(File.ReadAllBytes(file), ModelCredentialEntropy, DataProtectionScope.CurrentUser);
                    var cfg = serializer.Deserialize<AiModelServiceConfig>(Encoding.UTF8.GetString(clear));
                    if (cfg == null || string.IsNullOrWhiteSpace(cfg.baseUrl) || string.IsNullOrWhiteSpace(cfg.model)) continue;
                    var normChat = NormalizeOpenAiChatUrl(cfg.baseUrl);
                    var normKey = NormalizeApiKeyInput(cfg.key);
                    AiProviderEntry matched = null;
                    foreach (var existing in hub.providers)
                    {
                        if (string.Equals(NormalizeOpenAiChatUrl(existing.baseUrl), normChat, StringComparison.OrdinalIgnoreCase) &&
                            string.Equals(existing.apiKey ?? "", normKey ?? "", StringComparison.Ordinal))
                        {
                            matched = existing;
                            break;
                        }
                    }
                    if (matched == null)
                    {
                        matched = new AiProviderEntry
                        {
                            id = "prov-" + Guid.NewGuid().ToString("N").Substring(0, 10),
                            name = InferProviderDisplayName(cfg.baseUrl),
                            baseUrl = cfg.baseUrl.Trim().TrimEnd('/'),
                            apiKey = string.IsNullOrEmpty(normKey) ? "local" : normKey,
                            defaultModel = cfg.model.Trim()
                        };
                        hub.providers.Add(matched);
                    }
                    if (string.IsNullOrEmpty(hub.reader.providerId))
                    {
                        hub.reader.providerId = matched.id == hub.primaryProviderId ? "" : matched.id;
                        hub.reader.model = string.Equals(matched.defaultModel, cfg.model.Trim(), StringComparison.Ordinal) ? "" : cfg.model.Trim();
                    }
                }
                catch { }
            }
        }

        hub = NormalizeAiHubSettings(hub);
        PersistAiHubSettingsOnly(hub);
        return hub;
    }

    private AiHubSettings LoadAiHubSettings()
    {
        if (!File.Exists(AiHubSettingsPath)) return MigrateLegacySettingsToHub();
        try
        {
            var clear = ProtectedData.Unprotect(File.ReadAllBytes(AiHubSettingsPath), AiHubEntropy, DataProtectionScope.CurrentUser);
            var parsed = aiHubJson.Deserialize<AiHubSettings>(Encoding.UTF8.GetString(clear));
            if (parsed != null) return NormalizeAiHubSettings(parsed);
        }
        catch { }
        return MigrateLegacySettingsToHub();
    }

    private void PersistAiHubSettingsOnly(AiHubSettings hub)
    {
        var normalized = NormalizeAiHubSettings(hub);
        var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(aiHubJson.Serialize(normalized)), AiHubEntropy, DataProtectionScope.CurrentUser);
        var temp = AiHubSettingsPath + ".new";
        File.WriteAllBytes(temp, bytes);
        if (File.Exists(AiHubSettingsPath)) File.Replace(temp, AiHubSettingsPath, null);
        else File.Move(temp, AiHubSettingsPath);
    }

    private void SaveAiHubAndSyncTranslation(AiHubSettings hub)
    {
        var normalized = NormalizeAiHubSettings(hub);
        PersistAiHubSettingsOnly(normalized);
        if (File.Exists(TranslationSettingsPath))
        {
            bool recovered;
            var trans = LoadTranslationSettingsRaw(out recovered);
            if (!recovered && trans != null && trans.provider == "openai" && !string.IsNullOrEmpty(trans.openaiBaseUrl))
            {
                foreach (var p in normalized.providers)
                {
                    if (string.Equals(NormalizeOpenAiChatUrl(p.baseUrl), NormalizeOpenAiChatUrl(trans.openaiBaseUrl), StringComparison.OrdinalIgnoreCase))
                    {
                        if (!string.Equals(trans.openaiKey ?? "", p.apiKey ?? "", StringComparison.Ordinal))
                        {
                            trans.openaiKey = p.apiKey;
                            PersistTranslationSettingsRaw(trans, false);
                        }
                        break;
                    }
                }
            }
        }
    }

    private TranslationSettings BuildTranslationSettingsFromHub(AiHubSettings hub)
    {
        var targetProv = FindProviderById(hub.providers, hub.translateProviderId)
            ?? FindProviderById(hub.providers, hub.primaryProviderId);
        var resolvedModel = !string.IsNullOrWhiteSpace(hub.translateModel)
            ? hub.translateModel
            : (targetProv != null && !string.IsNullOrWhiteSpace(targetProv.defaultModel) ? targetProv.defaultModel : "deepseek-chat");
        var mode = hub.translateMode;
        if (mode == "cloud" && targetProv == null) mode = "localai";
        return new TranslationSettings
        {
            provider = mode == "cloud" ? "openai" : mode,
            openaiBaseUrl = targetProv != null ? targetProv.baseUrl : "https://api.deepseek.com",
            openaiKey = targetProv != null ? targetProv.apiKey : "",
            openaiModel = resolvedModel,
            openaiConcurrency = hub.translateConcurrency > 0 ? hub.translateConcurrency : 8,
            localModel = hub.localModel,
            baiduId = hub.baiduId,
            baiduSecret = hub.baiduSecret,
            azureKey = hub.azureKey,
            azureRegion = hub.azureRegion
        };
    }

    private Dictionary<string, object> ResolveHubScenarioConfig(AiHubSettings hub, string scene)
    {
        AiScenarioBinding binding = hub.reader;
        if (scene == "vision")
        {
            var hasDedicatedVision = !string.IsNullOrEmpty(hub.vision.providerId) || !string.IsNullOrEmpty(hub.vision.model);
            binding = hasDedicatedVision ? hub.vision : hub.reader;
        }
        else if (scene == "subtitle")
        {
            binding = hub.subtitle;
        }
        else if (scene == "translate")
        {
            binding = new AiScenarioBinding { providerId = hub.translateProviderId, model = hub.translateModel };
        }
        var prov = FindProviderById(hub.providers, binding != null ? binding.providerId : "")
            ?? FindProviderById(hub.providers, hub.primaryProviderId);
        if (prov == null) return null;
        var model = binding != null && !string.IsNullOrWhiteSpace(binding.model) ? binding.model.Trim() : prov.defaultModel;
        if (string.IsNullOrWhiteSpace(model)) return null;
        return new Dictionary<string, object>
        {
            { "providerId", prov.id },
            { "providerName", prov.name },
            { "baseUrl", prov.baseUrl },
            { "model", model },
            { "key", prov.apiKey == "local" ? "" : (prov.apiKey ?? "") }
        };
    }

    private object BuildClientAiHubState(AiHubSettings hub)
    {
        var providerItems = new List<object>();
        foreach (var p in hub.providers)
        {
            providerItems.Add(new
            {
                p.id,
                p.name,
                p.baseUrl,
                p.defaultModel,
                hasKey = !string.IsNullOrEmpty(p.apiKey) && p.apiKey != "local",
                isLocal = p.apiKey == "local",
                maskedKey = MaskSecretKey(p.apiKey)
            });
        }
        var resolvedReader = ResolveHubScenarioConfig(hub, "reader");
        var resolvedVision = ResolveHubScenarioConfig(hub, "vision");
        var resolvedSubtitle = ResolveHubScenarioConfig(hub, "subtitle");
        var resolvedTranslate = ResolveHubScenarioConfig(hub, "translate");
        return new
        {
            providers = providerItems,
            hub.primaryProviderId,
            hub.translateMode,
            hub.translateProviderId,
            hub.translateModel,
            hub.translateConcurrency,
            hub.localModel,
            baiduId = hub.baiduId ?? "",
            baiduConfigured = ValidTranslationKey(hub.baiduSecret),
            azureRegion = hub.azureRegion ?? "",
            azureConfigured = ValidTranslationKey(hub.azureKey),
            localLargeConfigured = FindLocalLlmModel("large") != null,
            localCompactConfigured = FindLocalLlmModel("compact") != null,
            localTinyConfigured = FindLocalLlmModel("tiny") != null,
            localLargePath = LocalLlmModelPath("large"),
            localCompactPath = LocalLlmModelPath("compact"),
            localTinyPath = LocalLlmModelPath("tiny"),
            reader = hub.reader,
            vision = hub.vision,
            subtitle = hub.subtitle,
            summaries = new
            {
                reader = resolvedReader != null ? resolvedReader["providerName"] + " · " + resolvedReader["model"] : "",
                vision = resolvedVision != null ? resolvedVision["providerName"] + " · " + resolvedVision["model"] : "",
                subtitle = resolvedSubtitle != null ? resolvedSubtitle["providerName"] + " · " + resolvedSubtitle["model"] : "",
                translate = hub.translateMode == "cloud" && resolvedTranslate != null
                    ? resolvedTranslate["providerName"] + " · " + resolvedTranslate["model"]
                    : ""
            }
        };
    }

    private static void ValidateHubProviderInput(string baseUrl, string defaultModel, string apiKey, out Uri parsedUri)
    {
        if (string.IsNullOrWhiteSpace(baseUrl) || baseUrl.Length > 512 ||
            !Uri.TryCreate(baseUrl.Trim(), UriKind.Absolute, out parsedUri) ||
            (parsedUri.Scheme != Uri.UriSchemeHttps && parsedUri.Scheme != Uri.UriSchemeHttp) ||
            parsedUri.UserInfo.Length != 0 || parsedUri.Query.Length != 0 || parsedUri.Fragment.Length != 0)
            throw new InvalidOperationException("请输入有效的 http(s) 接口地址（不含查询参数或账户密码）。");
        if (string.IsNullOrWhiteSpace(defaultModel) || defaultModel.Trim().Length > 140)
            throw new InvalidOperationException("请填写默认模型名称（例如 deepseek-chat 或 qwen-plus）。");
        if ((apiKey ?? "").Length > 1024 || (apiKey ?? "").IndexOfAny(new[] { '\r', '\n' }) >= 0)
            throw new InvalidOperationException("API 密钥格式无效。");
        if (string.IsNullOrEmpty(apiKey) && !parsedUri.IsLoopback)
            throw new InvalidOperationException("远程服务商请填写 API Key（已保存时留空可自动保留）。");
    }

    private static string ReadObjString(Dictionary<string, object> map, string key)
    {
        object val;
        return map != null && map.TryGetValue(key, out val) && val != null ? Convert.ToString(val).Trim() : "";
    }

    private async Task<bool> HandleAiHubMessage(CoreWebView2 web, string source)
    {
        if (source.Length > 65536 || source.IndexOf("donote-ai-hub", StringComparison.Ordinal) < 0) return false;
        Dictionary<string, object> req;
        try { req = aiHubJson.Deserialize<Dictionary<string, object>>(source); }
        catch { return false; }
        if (req == null || ReadObjString(req, "type") != "donote-ai-hub") return false;
        var id = ReadObjString(req, "id");
        Guid parsedId;
        if (!Guid.TryParse(id, out parsedId)) return true;
        var action = ReadObjString(req, "action");
        try
        {
            var hub = LoadAiHubSettings();
            if (action == "read")
            {
                var state = BuildClientAiHubState(hub);
                PostWorkspaceMessage(web, new { type = "donote-ai-hub-result", id, state });
                return true;
            }
            if (action == "resolve")
            {
                var scene = ReadObjString(req, "scene");
                if (string.IsNullOrEmpty(scene)) scene = "reader";
                var resolved = ResolveHubScenarioConfig(hub, scene);
                PostWorkspaceMessage(web, new { type = "donote-ai-hub-result", id, config = resolved });
                return true;
            }
            if (action == "resolve-provider")
            {
                var provId = ReadObjString(req, "providerId");
                var found = FindProviderById(hub.providers, provId);
                object cfg = found == null ? null : new
                {
                    providerId = found.id,
                    providerName = found.name,
                    baseUrl = found.baseUrl,
                    model = found.defaultModel,
                    key = found.apiKey == "local" ? "" : (found.apiKey ?? "")
                };
                PostWorkspaceMessage(web, new { type = "donote-ai-hub-result", id, config = cfg });
                return true;
            }
            if (action == "save-provider")
            {
                var payload = req.ContainsKey("provider") ? req["provider"] as Dictionary<string, object> : null;
                if (payload == null) throw new InvalidOperationException("服务商参数无效。");
                var provId = ReadObjString(payload, "id");
                var existing = FindProviderById(hub.providers, provId);
                var baseUrl = ReadObjString(payload, "baseUrl").TrimEnd('/');
                var defaultModel = ReadObjString(payload, "defaultModel");
                var name = ReadObjString(payload, "name");
                var rawKey = NormalizeApiKeyInput(ReadObjString(payload, "apiKey"));
                var sameHost = existing != null && string.Equals(NormalizeOpenAiChatUrl(existing.baseUrl), NormalizeOpenAiChatUrl(baseUrl), StringComparison.OrdinalIgnoreCase);
                var effectiveKey = rawKey.Length != 0 ? rawKey : (sameHost ? existing.apiKey : "");
                Uri parsedUri;
                ValidateHubProviderInput(baseUrl, defaultModel, effectiveKey, out parsedUri);
                if (string.IsNullOrEmpty(effectiveKey) && parsedUri.IsLoopback) effectiveKey = "local";
                if (existing != null)
                {
                    existing.name = string.IsNullOrWhiteSpace(name) ? InferProviderDisplayName(baseUrl) : name;
                    existing.baseUrl = baseUrl;
                    existing.defaultModel = defaultModel;
                    existing.apiKey = effectiveKey;
                }
                else
                {
                    if (hub.providers.Count >= 24) throw new InvalidOperationException("最多支持保存 24 个服务商配置。");
                    var created = new AiProviderEntry
                    {
                        id = "prov-" + Guid.NewGuid().ToString("N").Substring(0, 10),
                        name = string.IsNullOrWhiteSpace(name) ? InferProviderDisplayName(baseUrl) : name,
                        baseUrl = baseUrl,
                        defaultModel = defaultModel,
                        apiKey = effectiveKey
                    };
                    hub.providers.Add(created);
                    if (hub.providers.Count == 1 || ReadObjString(payload, "makePrimary") == "true")
                    {
                        hub.primaryProviderId = created.id;
                        if (hub.translateMode != "baidu" && hub.translateMode != "azure")
                        {
                            hub.translateMode = "cloud";
                            hub.translateProviderId = created.id;
                        }
                    }
                }
                if (ReadObjString(payload, "makePrimary") == "true" && existing != null)
                    hub.primaryProviderId = existing.id;
                SaveAiHubAndSyncTranslation(hub);
                SendTranslationSettings(web);
                var state = BuildClientAiHubState(hub);
                PostWorkspaceMessage(web, new { type = "donote-ai-hub-state", state });
                PostWorkspaceMessage(web, new { type = "donote-ai-hub-result", id, state });
                return true;
            }
            if (action == "delete-provider")
            {
                var provId = ReadObjString(req, "providerId");
                hub.providers.RemoveAll(p => string.Equals(p.id, provId, StringComparison.Ordinal));
                if (hub.translateProviderId == provId) hub.translateProviderId = "";
                if (hub.reader.providerId == provId) hub.reader.providerId = "";
                if (hub.vision.providerId == provId) hub.vision.providerId = "";
                if (hub.subtitle.providerId == provId) hub.subtitle.providerId = "";
                if (hub.providers.Count == 0 && hub.translateMode == "cloud") hub.translateMode = "localai";
                SaveAiHubAndSyncTranslation(hub);
                SendTranslationSettings(web);
                var state = BuildClientAiHubState(hub);
                PostWorkspaceMessage(web, new { type = "donote-ai-hub-state", state });
                PostWorkspaceMessage(web, new { type = "donote-ai-hub-result", id, state });
                return true;
            }
            if (action == "test-provider")
            {
                var payload = req.ContainsKey("provider") ? req["provider"] as Dictionary<string, object> : null;
                if (payload == null) throw new InvalidOperationException("测试参数无效。");
                var provId = ReadObjString(payload, "id");
                var existing = FindProviderById(hub.providers, provId);
                var baseUrl = ReadObjString(payload, "baseUrl").TrimEnd('/');
                var testModel = ReadObjString(payload, "defaultModel");
                if (existing != null && string.IsNullOrEmpty(baseUrl)) baseUrl = existing.baseUrl;
                if (existing != null && string.IsNullOrEmpty(testModel)) testModel = existing.defaultModel;
                var rawKey = NormalizeApiKeyInput(ReadObjString(payload, "apiKey"));
                var sameHost = existing != null && string.Equals(NormalizeOpenAiChatUrl(existing.baseUrl), NormalizeOpenAiChatUrl(baseUrl), StringComparison.OrdinalIgnoreCase);
                var effectiveKey = rawKey.Length != 0 ? rawKey : (sameHost ? existing.apiKey : "");
                Uri parsedUri;
                ValidateHubProviderInput(baseUrl, testModel, effectiveKey, out parsedUri);
                if (string.IsNullOrEmpty(effectiveKey) && parsedUri.IsLoopback) effectiveKey = "local";
                var tempSettings = new TranslationSettings
                {
                    provider = "openai",
                    openaiBaseUrl = baseUrl,
                    openaiModel = testModel,
                    openaiKey = effectiveKey,
                    openaiConcurrency = 1
                };
                using (var cts = new CancellationTokenSource(TimeSpan.FromSeconds(25)))
                {
                    var watch = Stopwatch.StartNew();
                    var sample = await TranslateWithProvider(tempSettings, "en", "zh",
                        "Low-noise amplifier and signal integrity.", "", cts.Token);
                    watch.Stop();
                    var preview = sample.Length > 36 ? sample.Substring(0, 36) + "…" : sample;
                    PostWorkspaceMessage(web, new
                    {
                        type = "donote-ai-hub-result",
                        id,
                        message = "✓ 连接正常（" + watch.Elapsed.TotalSeconds.ToString("0.0") + "s · " + testModel + "）：" + preview
                    });
                }
                return true;
            }
            if (action == "save-routing")
            {
                var routing = req.ContainsKey("routing") ? req["routing"] as Dictionary<string, object> : null;
                if (routing == null) throw new InvalidOperationException("场景路由参数无效。");
                var primaryId = ReadObjString(routing, "primaryProviderId");
                if (!string.IsNullOrEmpty(primaryId) && FindProviderById(hub.providers, primaryId) != null)
                    hub.primaryProviderId = primaryId;

                hub.reader = new AiScenarioBinding
                {
                    providerId = ReadObjString(routing, "readerProviderId"),
                    model = ReadObjString(routing, "readerModel")
                };
                hub.vision = new AiScenarioBinding
                {
                    providerId = ReadObjString(routing, "visionProviderId"),
                    model = ReadObjString(routing, "visionModel")
                };
                hub.subtitle = new AiScenarioBinding
                {
                    providerId = ReadObjString(routing, "subtitleProviderId"),
                    model = ReadObjString(routing, "subtitleModel")
                };

                SaveAiHubAndSyncTranslation(hub);
                var state = BuildClientAiHubState(hub);
                PostWorkspaceMessage(web, new { type = "donote-ai-hub-state", state });
                PostWorkspaceMessage(web, new { type = "donote-ai-hub-result", id, state });
                return true;
            }
            return true;
        }
        catch (Exception error)
        {
            var msg = error is InvalidOperationException || error is InvalidDataException
                ? error.Message : "无法保存或连接 AI 服务商，请检查网络或配置。";
            PostWorkspaceMessage(web, new { type = "donote-ai-hub-result", id, error = msg });
            return true;
        }
    }

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
            AiModelServiceConfig config = null;
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
                var resolved = ResolveHubScenarioConfig(LoadAiHubSettings(), "reader");
                if (resolved != null)
                {
                    config = new AiModelServiceConfig
                    {
                        baseUrl = Convert.ToString(resolved["baseUrl"]),
                        model = Convert.ToString(resolved["model"]),
                        key = Convert.ToString(resolved["key"])
                    };
                }
                else if (File.Exists(path))
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
