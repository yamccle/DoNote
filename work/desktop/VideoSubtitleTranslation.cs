using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

internal sealed partial class WorkspaceWindow
{
    private const string LocalSubtitlePrefix = "subtitle-local:";
    private Process subtitleTranslationProcess;
    private string subtitleTranslationId;

    private async Task HandleLocalSubtitleTranslation(CoreWebView2 web, string command)
    {
        // The request ID comes first so an oversized payload can get an explicit error.
        int start = LocalSubtitlePrefix.Length;
        int separator = command.IndexOf(':', start);
        Guid requestGuid;
        if (separator != start + 36 || !Guid.TryParseExact(command.Substring(start, 36), "D", out requestGuid))
            return;
        string id = requestGuid.ToString("D");
        string payload = command.Substring(separator + 1);
        if (payload == "cancel")
        {
            if (subtitleTranslationId == id) StopLocalSubtitleTranslation();
            return;
        }

        try
        {
            if (subtitleTranslationProcess != null)
                throw new InvalidOperationException("已有免费翻译任务在运行，请稍后重试。");
            if (Encoding.UTF8.GetByteCount(payload) > 4 * 1024 * 1024)
                throw new InvalidOperationException("英文字幕过多，请分段翻译。");

            string app = AppDomain.CurrentDomain.BaseDirectory;
            string python = Path.Combine(app, "video-runtime", "python.exe");
            string worker = Path.Combine(app, "video-runtime", "workers", "video-translate.py");
            if (!File.Exists(python) || !File.Exists(worker) ||
                !File.Exists(Path.Combine(app, "video-runtime", "translation-en-zh", "model.bin")))
                throw new InvalidOperationException("缺少本地翻译模型，请使用完整更新包。");

            var info = new ProcessStartInfo(python, "-B -X utf8 \"" + worker + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            using (var process = new Process { StartInfo = info })
            {
                if (!process.Start()) throw new InvalidOperationException("无法启动本地翻译。");
                subtitleTranslationProcess = process;
                subtitleTranslationId = id;
                try
                {
                    var output = ForwardLocalSubtitleResults(web, id, process);
                    var errors = process.StandardError.ReadToEndAsync();
                    byte[] input = Encoding.UTF8.GetBytes(payload);
                    try
                    {
                        await process.StandardInput.BaseStream.WriteAsync(input, 0, input.Length);
                        process.StandardInput.Close();
                    }
                    catch (IOException)
                    {
                        // The worker may have exited before it could read the full payload.
                        // Its JSON response or stderr below contains the cause.
                        if (!process.HasExited) throw;
                    }
                    if (await Task.WhenAny(output, Task.Delay(TimeSpan.FromHours(1))) != output)
                        throw new InvalidOperationException("本地翻译超时。已完成的译文会保留。");
                    if (!await output)
                    {
                        var detail = (await errors).Trim();
                        var suffix = detail.Length == 0 ? "" : " " + detail.Substring(Math.Max(0, detail.Length - 350));
                        var code = process.HasExited ? "（代码 " + process.ExitCode + "）" : "";
                        throw new InvalidOperationException("离线字幕翻译进程意外退出" + code + "。" + suffix);
                    }
                }
                finally
                {
                    StopLocalSubtitleTranslation();
                    subtitleTranslationProcess = null;
                    subtitleTranslationId = null;
                }
            }
        }
        catch (Exception error)
        {
            if (!IsDisposed && !Disposing)
                PostWorkspaceMessage(web, new { type = "subtitle-local-result", id,
                    error = error is InvalidOperationException ? error.Message : "离线字幕翻译中断：" + error.Message });
        }
    }

    private async Task<bool> ForwardLocalSubtitleResults(CoreWebView2 web, string id, Process process)
    {
        string line;
        var serializer = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 8 };
        while ((line = await process.StandardOutput.ReadLineAsync()) != null)
        {
            var message = serializer.Deserialize<Dictionary<string, object>>(line);
            message["type"] = "subtitle-local-result";
            message["id"] = id;
            if (!IsDisposed && !Disposing && string.Equals(web.Source, WorkspaceUrl, StringComparison.Ordinal))
                web.PostWebMessageAsJson(serializer.Serialize(message));
            if (message.ContainsKey("done") || message.ContainsKey("error")) return true;
        }
        return false;
    }

    private void StopLocalSubtitleTranslation()
    {
        try
        {
            if (subtitleTranslationProcess != null && !subtitleTranslationProcess.HasExited)
                subtitleTranslationProcess.Kill();
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }
}
