using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

internal sealed partial class WorkspaceWindow
{
    private const int MinerUChunkBytes = 256 * 1024;
    private readonly JavaScriptSerializer mineruJson = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024, RecursionLimit = 16 };
    private FileStream mineruPdfStream;
    private string mineruPdfDirectory;
    private string mineruPdfPath;
    private string mineruDocumentId;
    private SHA256 mineruPdfHasher;
    private string mineruPdfHash;
    private long mineruPdfExpected;
    private long mineruPdfReceived;
    private int mineruPdfNextChunk;
    private Process mineruProcess;
    private string mineruRequestId;

    private async Task<bool> HandleMinerUReflowMessage(CoreWebView2 web, string requestJson)
    {
        if (requestJson.Length > 360000) return false;
        Dictionary<string, object> request;
        try { request = mineruJson.Deserialize<Dictionary<string, object>>(requestJson); }
        catch { return false; }
        if (request == null) return false;
        object value;
        if (!request.TryGetValue("type", out value)) return false;
        var type = value as string;
        if (type != "mineru-open" && type != "mineru-chunk" && type != "mineru-ready" &&
            type != "mineru-parse" && type != "mineru-cancel" && type != "mineru-close") return false;

        Guid requestGuid;
        if (!request.TryGetValue("id", out value) || !Guid.TryParse(value as string, out requestGuid)) return true;
        var id = requestGuid.ToString("D");
        try
        {
            if (type == "mineru-open")
            {
                var size = request.TryGetValue("size", out value) ? Convert.ToInt64(value) : 0;
                if (size <= 0 || size > 2L * 1024 * 1024 * 1024) throw new InvalidDataException("PDF 大小无效。");
                StopMinerUReflow();
                var root = Path.Combine(dataRoot, "MinerU", "temp");
                Directory.CreateDirectory(root);
                CleanupStaleMinerU(root);
                mineruPdfDirectory = Path.Combine(root, "dnt-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(mineruPdfDirectory);
                mineruPdfPath = Path.Combine(mineruPdfDirectory, "source.pdf");
                mineruPdfStream = new FileStream(mineruPdfPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                    MinerUChunkBytes, FileOptions.SequentialScan);
                mineruPdfHasher = SHA256.Create();
                mineruDocumentId = id;
                mineruPdfExpected = size;
                mineruPdfReceived = 0;
                mineruPdfNextChunk = 0;
                PostWorkspaceMessage(web, new { type = "mineru-reflow-ack", id, seq = -1 });
                return true;
            }
            if (type == "mineru-chunk")
            {
                if (mineruPdfStream == null || mineruDocumentId != id) throw new InvalidDataException("没有对应的 PDF 上传任务。");
                var seq = request.TryGetValue("seq", out value) ? Convert.ToInt32(value) : -1;
                if (seq != mineruPdfNextChunk) throw new InvalidDataException("PDF 数据顺序错误。");
                var encoded = request.TryGetValue("data", out value) ? Convert.ToString(value) : "";
                if (String.IsNullOrEmpty(encoded) || encoded.Length > 349528) throw new InvalidDataException("PDF 数据块无效。");
                var bytes = Convert.FromBase64String(encoded);
                if (bytes.Length <= 0 || bytes.Length > MinerUChunkBytes || mineruPdfReceived + bytes.Length > mineruPdfExpected)
                    throw new InvalidDataException("PDF 数据大小错误。");
                mineruPdfStream.Write(bytes, 0, bytes.Length);
                mineruPdfHasher.TransformBlock(bytes, 0, bytes.Length, null, 0);
                mineruPdfReceived += bytes.Length;
                mineruPdfNextChunk++;
                PostWorkspaceMessage(web, new { type = "mineru-reflow-ack", id, seq });
                return true;
            }
            if (type == "mineru-ready")
            {
                if (mineruPdfStream == null || mineruDocumentId != id || mineruPdfReceived != mineruPdfExpected)
                    throw new InvalidDataException("PDF 上传不完整。");
                mineruPdfStream.Dispose();
                mineruPdfStream = null;
                mineruPdfHasher.TransformFinalBlock(new byte[0], 0, 0);
                mineruPdfHash = BitConverter.ToString(mineruPdfHasher.Hash).Replace("-", "").ToLowerInvariant();
                mineruPdfHasher.Dispose();
                mineruPdfHasher = null;
                PostWorkspaceMessage(web, new { type = "mineru-reflow-ready", id });
                return true;
            }
            if (type == "mineru-parse")
            {
                if (mineruRequestId != null) throw new InvalidOperationException("已有 MinerU 排版任务在运行。");
                var documentId = request.TryGetValue("documentId", out value) ? Convert.ToString(value) : "";
                if (mineruPdfHash == null || documentId != mineruDocumentId)
                    throw new InvalidOperationException("PDF 尚未准备完成。");
                var start = request.TryGetValue("start", out value) ? Convert.ToInt32(value) : 0;
                var end = request.TryGetValue("end", out value) ? Convert.ToInt32(value) : 0;
                var tier = request.TryGetValue("tier", out value) ? Convert.ToString(value) : "flash";
                if (start < 1 || end < start || end - start > 20) throw new InvalidDataException("MinerU 页码范围无效。");
                if (tier != "flash" && tier != "basic" && tier != "standard" && tier != "advanced")
                    throw new InvalidDataException("MinerU 解析档位无效。");
                await ParseMinerUPages(web, id, start, end, tier);
                return true;
            }
            if (type == "mineru-close" || type == "mineru-cancel")
            {
                if (id == mineruDocumentId) StopMinerUReflow();
                else if (type == "mineru-cancel" && id == mineruRequestId) StopMinerUWorker();
                return true;
            }
        }
        catch (Exception error)
        {
            var message = error is InvalidOperationException || error is InvalidDataException || error is IOException
                ? error.Message : "MinerU 排版失败，请重试。";
            PostWorkspaceMessage(web, new { type = "mineru-reflow-error", id, error = message });
        }
        return true;
    }

    private async Task ParseMinerUPages(CoreWebView2 web, string id, int start, int end, string tier)
    {
        var cachePath = Path.Combine(dataRoot, "MinerU", "cache", mineruPdfHash,
            tier + "-reflow-v5-" + start + "-" + end + ".json");
        Dictionary<string, object> result = null;
        try
        {
            if (File.Exists(cachePath))
                result = mineruJson.Deserialize<Dictionary<string, object>>(File.ReadAllText(cachePath, Encoding.UTF8));
        }
        catch { }

        if (result == null || !result.ContainsKey("pages"))
        {
            var process = GetMinerUWorker();
            mineruRequestId = id;
            try
            {
                var range = start == end ? start.ToString() : start + "–" + end;
                PostWorkspaceMessage(web, new { type = "mineru-reflow-progress", id,
                    status = "MinerU 正在解析第 " + range + " 页…" });
                await process.StandardInput.WriteLineAsync(mineruJson.Serialize(new { start, end, tier }));
                var output = process.StandardOutput.ReadLineAsync();
                using (var timeout = new CancellationTokenSource())
                {
                    var deadline = Task.Delay(TimeSpan.FromMinutes(20), timeout.Token);
                    if (await Task.WhenAny(output, deadline) != output)
                        throw new InvalidOperationException("MinerU 解析超时。");
                    timeout.Cancel();
                }
                var text = await output;
                if (mineruProcess != process) return;
                if (String.IsNullOrEmpty(text))
                    throw new InvalidOperationException("MinerU 进程已退出，请重试。");
                try { result = mineruJson.Deserialize<Dictionary<string, object>>(text); }
                catch { throw new InvalidOperationException("MinerU 返回了无法识别的结果。"); }
                if (result == null || (!result.ContainsKey("pages") && !result.ContainsKey("error")))
                    throw new InvalidOperationException("MinerU 返回了无法识别的结果。");
                if (result.ContainsKey("pages") && !result.ContainsKey("error"))
                    SaveMinerUCache(cachePath, result);
            }
            catch
            {
                if (mineruProcess != process) return;
                StopMinerUWorker();
                throw;
            }
            finally
            {
                if (mineruRequestId == id) mineruRequestId = null;
                if (mineruProcess != process) process.Dispose();
            }
        }
        result["id"] = id;
        result["type"] = "mineru-reflow-result";
        if (!IsDisposed && !Disposing && String.Equals(web.Source, WorkspaceUrl, StringComparison.Ordinal))
            web.PostWebMessageAsJson(mineruJson.Serialize(result));
    }

    private Process GetMinerUWorker()
    {
        if (mineruProcess != null && !mineruProcess.HasExited) return mineruProcess;
        StopMinerUWorker();
        var runtime = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "video-runtime");
        var python = Path.Combine(runtime, "python.exe");
        var worker = Path.Combine(runtime, "workers", "mineru-reflow.py");
        if (!File.Exists(python) || !File.Exists(worker) ||
            !Directory.Exists(Path.Combine(runtime, "mineru-dependencies")))
            throw new InvalidOperationException("MinerU 运行组件不完整，请重新安装完整版本。");
        var info = new ProcessStartInfo(python, "-B -u \"" + worker + "\" --serve \"" + mineruPdfPath + "\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        info.EnvironmentVariables["MINERU_HOME"] = Path.Combine(dataRoot, "MinerU");
        if (!info.EnvironmentVariables.ContainsKey("MINERU_MODEL_SOURCE"))
            info.EnvironmentVariables["MINERU_MODEL_SOURCE"] = "modelscope";
        var installedModels = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "models", "mineru");
        if (Directory.Exists(installedModels) && !info.EnvironmentVariables.ContainsKey("MINERU_MODEL_BASE_DIR"))
            info.EnvironmentVariables["MINERU_MODEL_BASE_DIR"] = installedModels;
        info.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        var process = new Process { StartInfo = info };
        try
        {
            if (!process.Start()) throw new IOException("无法启动 MinerU。");
            process.BeginErrorReadLine();
            process.StandardInput.AutoFlush = true;
            mineruProcess = process;
            return process;
        }
        catch
        {
            try { process.Kill(); } catch { }
            process.Dispose();
            throw;
        }
    }

    private void SaveMinerUCache(string path, Dictionary<string, object> result)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".new";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(temporary, mineruJson.Serialize(result), Encoding.UTF8);
            if (File.Exists(path)) File.Replace(temporary, path, null);
            else File.Move(temporary, path);
        }
        catch { try { File.Delete(temporary); } catch { } }
    }

    private void CleanupMinerUPdf()
    {
        try { if (mineruPdfStream != null) mineruPdfStream.Dispose(); } catch { }
        mineruPdfStream = null;
        if (mineruPdfHasher != null) mineruPdfHasher.Dispose();
        mineruPdfHasher = null;
        mineruPdfHash = null;
        try
        {
            if (!String.IsNullOrEmpty(mineruPdfDirectory) && Directory.Exists(mineruPdfDirectory))
                Directory.Delete(mineruPdfDirectory, true);
        }
        catch { }
        mineruPdfDirectory = mineruPdfPath = mineruDocumentId = null;
        mineruPdfExpected = mineruPdfReceived = 0;
        mineruPdfNextChunk = 0;
    }

    private static void CleanupStaleMinerU(string root)
    {
        try
        {
            foreach (var directory in Directory.EnumerateDirectories(root, "dnt-*"))
                if (Directory.GetLastWriteTimeUtc(directory) < DateTime.UtcNow.AddDays(-1))
                    Directory.Delete(directory, true);
        }
        catch { }
    }

    private void StopMinerUWorker()
    {
        var process = mineruProcess;
        var hasRequest = mineruRequestId != null;
        mineruProcess = null;
        mineruRequestId = null;
        if (process == null) return;
        try { if (!process.HasExited) process.Kill(); } catch { }
        if (!hasRequest) process.Dispose();
    }

    private void StopMinerUReflow()
    {
        StopMinerUWorker();
        CleanupMinerUPdf();
    }
}
