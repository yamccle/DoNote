using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal sealed partial class WorkspaceWindow
{
    private const string LocalLlmModelName = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
    private const string LocalLlmCompactModelName = "Qwen3-1.7B-Q4_K_M.gguf";
    private const string LocalLlmTinyModelName = "Qwen3-0.6B-Q8_0.gguf";
    private const string LocalLlmTinyLegacyModelName = "Qwen3_0_6B-Q8_0.gguf";
    private readonly SemaphoreSlim localLlmGate = new SemaphoreSlim(1, 1);
    private Process localLlmProcess;
    private Task<string> localLlmErrors;
    private string localLlmActiveModel;

    private string LocalLlmModelDirectory
    {
        get { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "models", "translation"); }
    }

    private string LocalLlmModelPath(string preference)
    {
        return FindLocalLlmModel(preference) ?? ExpectedLocalLlmModelPath(preference);
    }

    private string ExpectedLocalLlmModelPath(string preference)
    {
        var name = LocalLlmModelName;
        if (preference == "compact") name = LocalLlmCompactModelName;
        if (preference == "tiny") name = LocalLlmTinyModelName;
        return Path.Combine(LocalLlmModelDirectory, name);
    }

    private string FindLocalLlmModel(string preference)
    {
        var preferred = ExpectedLocalLlmModelPath(preference);
        if (File.Exists(preferred)) return preferred;
        if (preference == "tiny")
        {
            var legacy = Path.Combine(LocalLlmModelDirectory, LocalLlmTinyLegacyModelName);
            if (File.Exists(legacy)) return legacy;
        }
        return null;
    }

    private string LocalLlmMissingMessage(string preference)
    {
        return "未找到本地翻译模型。请把 " + Path.GetFileName(ExpectedLocalLlmModelPath(preference))
            + " 放到：" + LocalLlmModelDirectory;
    }

    private string LocalLlmModelCacheKey(string preference)
    {
        var info = new FileInfo(LocalLlmModelPath(preference));
        try { return info.Exists ? info.Name + ":" + info.Length + ":" + info.LastWriteTimeUtc.Ticks : ""; }
        catch (IOException) { return ""; }
        catch (UnauthorizedAccessException) { return ""; }
    }

    private void OpenLocalLlmModelDirectory()
    {
        Directory.CreateDirectory(LocalLlmModelDirectory);
        Process.Start(new ProcessStartInfo
        {
            FileName = "explorer.exe",
            Arguments = "\"" + LocalLlmModelDirectory + "\"",
            UseShellExecute = true
        });
    }

    private void OpenAsrModelDirectory()
    {
        var folder = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "models", "asr");
        Directory.CreateDirectory(folder);
        Process.Start(new ProcessStartInfo
        {
            FileName = "explorer.exe",
            Arguments = "\"" + folder + "\"",
            UseShellExecute = true
        });
    }

    private Process EnsureLocalLlmProcess(string model)
    {
        if (localLlmProcess != null && !localLlmProcess.HasExited && localLlmActiveModel == model) return localLlmProcess;
        StopLocalLlmTranslation();

        if (model == null) throw new InvalidOperationException("未找到本地翻译模型。");
        var app = AppDomain.CurrentDomain.BaseDirectory;
        var python = Path.Combine(app, "video-runtime", "python.exe");
        var worker = Path.Combine(app, "video-runtime", "workers", "local-llm-translate.py");
        var dependency = Path.Combine(app, "video-runtime", "translation-dependencies", "llama_cpp");
        if (!File.Exists(python) || !File.Exists(worker) || !Directory.Exists(dependency))
            throw new InvalidOperationException("本地大模型翻译组件不完整，请使用完整安装包。");

        var info = new ProcessStartInfo(python, "-B -X utf8 \"" + worker + "\" \"" + model + "\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = app
        };
        localLlmProcess = new Process { StartInfo = info };
        if (!localLlmProcess.Start()) throw new InvalidOperationException("无法启动本地大模型翻译进程。");
        localLlmActiveModel = model;
        localLlmErrors = localLlmProcess.StandardError.ReadToEndAsync();
        return localLlmProcess;
    }

    private async Task<string> TranslateWithLocalLlm(string source, string target, string text, string context, string preference, CancellationToken cancellation)
    {
        var model = FindLocalLlmModel(preference);
        if (model == null) throw new InvalidOperationException(LocalLlmMissingMessage(preference));
        await localLlmGate.WaitAsync(cancellation);
        try
        {
            var process = EnsureLocalLlmProcess(model);
            var id = Guid.NewGuid().ToString("N");
            var request = new Dictionary<string, object>
            {
                {"request", id},
                {"mode", "text"},
                {"source", source},
                {"target", target},
                {"text", CleanUtf8Text(text)},
                {"context", CleanUtf8Text(context)}
            };
            using (cancellation.Register(StopLocalLlmTranslation))
            using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            {
                var bytes = Encoding.UTF8.GetBytes(translationJson.Serialize(request) + "\n");
                var input = process.StandardInput.BaseStream;
                await input.WriteAsync(bytes, 0, bytes.Length, cancellation);
                await input.FlushAsync(cancellation);

                var read = process.StandardOutput.ReadLineAsync();
                if (await Task.WhenAny(read, Task.Delay(TimeSpan.FromMinutes(8), deadline.Token)) != read)
                {
                    cancellation.ThrowIfCancellationRequested();
                    StopLocalLlmTranslation();
                    throw new InvalidOperationException("本地大模型翻译超时，请重试。");
                }
                deadline.Cancel();
                cancellation.ThrowIfCancellationRequested();
                return ReadLocalLlmResult(await read);
            }
        }
        finally
        {
            localLlmGate.Release();
        }
    }

    private string ReadLocalLlmResult(string line)
    {
        if (line == null)
        {
            var detail = localLlmErrors != null && localLlmErrors.IsCompleted
                ? localLlmErrors.Result.Trim() : "";
            StopLocalLlmTranslation();
            throw new InvalidOperationException("本地大模型进程意外退出。"
                + (detail.Length == 0 ? "" : " " + detail.Substring(Math.Max(0, detail.Length - 300))));
        }
        Dictionary<string, object> result;
        try { result = translationJson.Deserialize<Dictionary<string, object>>(line); }
        catch (Exception) { throw new InvalidOperationException("本地大模型返回了无法识别的结果。"); }
        object value;
        if (result.TryGetValue("error", out value))
            throw new InvalidOperationException(Convert.ToString(value));
        if (!result.TryGetValue("text", out value) || !(value is string) || ((string)value).Trim().Length == 0)
            throw new InvalidOperationException("本地大模型没有返回有效译文。");
        return ((string)value).Trim();
    }

    private void StopLocalLlmTranslation()
    {
        try
        {
            if (localLlmProcess != null && !localLlmProcess.HasExited)
                localLlmProcess.Kill();
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        finally
        {
            if (localLlmProcess != null) localLlmProcess.Dispose();
            localLlmProcess = null;
            localLlmErrors = null;
            localLlmActiveModel = null;
        }
    }

    private static string CleanUtf8Text(string value)
    {
        if (String.IsNullOrEmpty(value)) return "";
        var output = new StringBuilder(value.Length);
        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            if (Char.IsHighSurrogate(character) && index + 1 < value.Length && Char.IsLowSurrogate(value[index + 1]))
            {
                output.Append(character);
                output.Append(value[++index]);
            }
            else if (Char.IsSurrogate(character)) output.Append('\uFFFD');
            else if (character != '\0') output.Append(character);
        }
        return output.ToString();
    }
}
