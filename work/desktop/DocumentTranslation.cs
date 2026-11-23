using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

internal sealed partial class WorkspaceWindow
{
    private const int Pdf2zhChunkBytes = 256 * 1024;
    private readonly SemaphoreSlim bilingualPairGate = new SemaphoreSlim(1, 1);
    private readonly Dictionary<string, CancellationTokenSource> bilingualPairRequests = new Dictionary<string, CancellationTokenSource>();
    private Process bilingualPairWorker;
    private string bilingualPairRequestId;
    private readonly JavaScriptSerializer documentTranslationJson =
        new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 24 };
    private FileStream pdf2zhStream;
    private string pdf2zhDirectory;
    private string pdf2zhPath;
    private string pdf2zhDocumentId;
    private long pdf2zhExpected;
    private long pdf2zhReceived;
    private int pdf2zhNextChunk;
    private Process pdf2zhProcess;
    private string pdf2zhRequestId;
    private System.Windows.Forms.Timer pdf2zhIdleTimer;
    private readonly Dictionary<Process, string> pdf2zhWorkerDirectories = new Dictionary<Process, string>();
    private readonly Dictionary<Process, StringBuilder> documentWorkerDiagnostics = new Dictionary<Process, StringBuilder>();

    private async Task<bool> HandleDocumentTranslationMessage(CoreWebView2 web, string requestJson)
    {
        if (requestJson.Length > 16 * 1024 * 1024) return false;
        Dictionary<string, object> request;
        try { request = documentTranslationJson.Deserialize<Dictionary<string, object>>(requestJson); }
        catch { return false; }
        object value;
        if (request == null || !request.TryGetValue("type", out value)) return false;
        var type = value as string;
        if (type == "bilingual-pair") return await PairBilingualMarkdown(web, request);
        if (type == "bilingual-pair-cancel")
        {
            CancellationTokenSource cancel;
            if (request.TryGetValue("id", out value) && value is string &&
                bilingualPairRequests.TryGetValue((string)value, out cancel))
            {
                cancel.Cancel();
                if (bilingualPairRequestId == (string)value) StopBilingualPairWorker();
            }
            return true;
        }
        if (type != "pdf2zh-open" && type != "pdf2zh-chunk" && type != "pdf2zh-ready" &&
            type != "pdf2zh-translate" && type != "pdf2zh-cancel-page" &&
            type != "pdf2zh-cancel" && type != "pdf2zh-close") return false;

        Guid requestGuid;
        if (!request.TryGetValue("id", out value) || !Guid.TryParse(value as string, out requestGuid)) return true;
        var id = requestGuid.ToString("D");
        try
        {
            if (type == "pdf2zh-open")
            {
                if (pdf2zhDocumentId != null) throw new InvalidOperationException("已有整页翻译文档，请关闭后重试。");
                var size = request.TryGetValue("size", out value) ? Convert.ToInt64(value) : 0;
                if (size <= 0 || size > 2L * 1024 * 1024 * 1024) throw new InvalidDataException("PDF 大小无效。");
                var root = Path.Combine(dataRoot, "PdfMathTranslate", "temp");
                Directory.CreateDirectory(root);
                pdf2zhDirectory = Path.Combine(root, "dnt-" + Guid.NewGuid().ToString("N"));
                pdf2zhDocumentId = id;
                Directory.CreateDirectory(pdf2zhDirectory);
                pdf2zhPath = Path.Combine(pdf2zhDirectory, "source.pdf");
                pdf2zhStream = new FileStream(pdf2zhPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                    Pdf2zhChunkBytes, FileOptions.SequentialScan);
                pdf2zhExpected = size;
                pdf2zhReceived = 0;
                pdf2zhNextChunk = 0;
                if (pdf2zhIdleTimer != null) pdf2zhIdleTimer.Stop();
                // Import the translation runtime while the WebView transfers the PDF.
                EnsureDocumentWorker(ref pdf2zhProcess, "pdfmathtranslate.py",
                    "pdfmathtranslate-dependencies", "PDFMathTranslate");
                PostWorkspaceMessage(web, new { type = "pdf2zh-ack", id, seq = -1 });
                return true;
            }
            if (type == "pdf2zh-chunk")
            {
                if (pdf2zhStream == null || pdf2zhDocumentId != id) throw new InvalidDataException("没有对应的 PDFMathTranslate 上传任务。");
                var seq = request.TryGetValue("seq", out value) ? Convert.ToInt32(value) : -1;
                if (seq != pdf2zhNextChunk) throw new InvalidDataException("PDFMathTranslate PDF 数据顺序错误。");
                var encoded = request.TryGetValue("data", out value) ? Convert.ToString(value) : "";
                if (String.IsNullOrEmpty(encoded) || encoded.Length > 349528) throw new InvalidDataException("PDFMathTranslate PDF 数据块无效。");
                var bytes = Convert.FromBase64String(encoded);
                if (bytes.Length <= 0 || bytes.Length > Pdf2zhChunkBytes || pdf2zhReceived + bytes.Length > pdf2zhExpected)
                    throw new InvalidDataException("PDFMathTranslate PDF 数据大小错误。");
                pdf2zhStream.Write(bytes, 0, bytes.Length);
                pdf2zhReceived += bytes.Length;
                pdf2zhNextChunk++;
                PostWorkspaceMessage(web, new { type = "pdf2zh-ack", id, seq });
                return true;
            }
            if (type == "pdf2zh-ready")
            {
                if (pdf2zhStream == null || pdf2zhDocumentId != id || pdf2zhReceived != pdf2zhExpected)
                    throw new InvalidDataException("PDFMathTranslate PDF 上传不完整。");
                pdf2zhStream.Dispose();
                pdf2zhStream = null;
                PostWorkspaceMessage(web, new { type = "pdf2zh-ready", id });
                return true;
            }
            if (type == "pdf2zh-cancel-page" || type == "pdf2zh-translate")
            {
                var documentId = request.TryGetValue("documentId", out value) ? Convert.ToString(value) : "";
                if (type == "pdf2zh-cancel-page")
                {
                    if (documentId == pdf2zhDocumentId && id == pdf2zhRequestId) StopPdf2zhPage();
                    return true;
                }
                if (pdf2zhRequestId != null) throw new InvalidOperationException("已有 PDFMathTranslate 任务在运行。");
                if (pdf2zhStream != null || String.IsNullOrEmpty(pdf2zhPath) || documentId != pdf2zhDocumentId || !File.Exists(pdf2zhPath))
                    throw new InvalidOperationException("PDF 尚未准备完成。");
                var start = request.TryGetValue("start", out value) ? Convert.ToInt32(value) : 0;
                var end = request.TryGetValue("end", out value) ? Convert.ToInt32(value) : 0;
                var preference = request.TryGetValue("preference", out value) ? Convert.ToString(value) : "large";
                var mode = request.TryGetValue("mode", out value) ? Convert.ToString(value) : "fast";
                if (start < 1 || end != start) throw new InvalidDataException("整页对照每次处理一页。");
                if (mode != "fast" && mode != "full") throw new InvalidDataException("PDFMathTranslate 模式无效。");
                var offline = preference == "offline";
                var model = offline ? null : FindLocalLlmModel(preference);
                if (!offline && model == null) throw new InvalidOperationException(LocalLlmMissingMessage(preference));
                if (bilingualPairRequestId == null) StopBilingualPairWorker();
                var directory = pdf2zhDirectory;
                var output = Path.Combine(directory, "page-" + Guid.NewGuid().ToString("N"));
                var payload = documentTranslationJson.Serialize(CleanDocumentTranslationValue(new
                {
                    source = pdf2zhPath,
                    output,
                    start,
                    end,
                    model,
                    mode,
                    engine = offline ? "offline" : "gguf"
                }));
                var process = EnsureDocumentWorker(ref pdf2zhProcess, "pdfmathtranslate.py",
                    "pdfmathtranslate-dependencies", "PDFMathTranslate");
                pdf2zhRequestId = id;
                pdf2zhWorkerDirectories.Add(process, directory);
                try
                {
                    PostWorkspaceMessage(web, new { type = "pdf2zh-progress", id,
                        status = (offline ? "离线快速翻译" : "本地大模型翻译") + " · 第 " + start + " 页…" });
                    Dictionary<string, object> result;
                    try
                    {
                        result = await RunDocumentWorker(process, payload, "pdf2zh-result", TimeSpan.FromMinutes(25),
                            "整页翻译超时，请重试。", message =>
                        {
                            if (process == pdf2zhProcess && message["type"] as string == "pdf2zh-paragraph")
                                PostDocumentWorkerMessage(web, new { type = "pdf2zh-paragraph", id, text = message["text"] });
                        });
                    }
                    catch
                    {
                        if (process != pdf2zhProcess) return true;
                        StopPdf2zhPage();
                        throw;
                    }
                    if (process != pdf2zhProcess) return true;
                    if (result.ContainsKey("error"))
                        throw new InvalidOperationException(Convert.ToString(result["error"]));
                    var monoPath = Path.GetFullPath(Convert.ToString(result["mono"]));
                    var expectedRoot = Path.GetFullPath(output).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                    if (!monoPath.StartsWith(expectedRoot, StringComparison.OrdinalIgnoreCase) || !File.Exists(monoPath))
                        throw new InvalidDataException("译文 PDF 无效。");
                    using (var stream = File.OpenRead(monoPath))
                    {
                        if (stream.Length <= 0 || stream.Length > 80L * 1024 * 1024)
                            throw new InvalidDataException("译文 PDF 大小超出预览限制。");
                        var buffer = new byte[Pdf2zhChunkBytes];
                        var seq = 0;
                        int count;
                        while ((count = stream.Read(buffer, 0, buffer.Length)) != 0)
                        {
                            if (process != pdf2zhProcess || IsDisposed || Disposing) return true;
                            if (string.Equals(web.Source, WorkspaceUrl, StringComparison.Ordinal))
                                web.PostWebMessageAsJson(documentTranslationJson.Serialize(new {
                                    type = "pdf2zh-output", id, seq = seq++, data = Convert.ToBase64String(buffer, 0, count)
                                }));
                            await Task.Yield();
                        }
                        if (process != pdf2zhProcess || IsDisposed || Disposing) return true;
                        PostWorkspaceMessage(web, new { type = "pdf2zh-result", id, start, end, size = stream.Length,
                            untranslatedPages = result.TryGetValue("untranslatedPages", out value) ? value : null,
                            skippedParagraphs = result.TryGetValue("skippedParagraphs", out value) ? value : null });
                    }
                }
                finally
                {
                    if (process == pdf2zhProcess) pdf2zhRequestId = null;
                    else process.Dispose();
                    pdf2zhWorkerDirectories.Remove(process);
                    DeletePdf2zhDirectory(output);
                    if (directory != pdf2zhDirectory && !pdf2zhWorkerDirectories.ContainsValue(directory))
                        DeletePdf2zhDirectory(directory);
                }
                return true;
            }
            if (type == "pdf2zh-cancel" || type == "pdf2zh-close")
            {
                if (pdf2zhDocumentId == id) ClosePdf2zhDocument();
                return true;
            }
        }
        catch (Exception error)
        {
            var message = error is InvalidOperationException || error is InvalidDataException || error is IOException
                ? error.Message : "PDFMathTranslate 处理失败，请重试。";
            PostWorkspaceMessage(web, new { type = "pdf2zh-result", id, error = message });
        }
        return true;
    }

    private async Task<bool> PairBilingualMarkdown(CoreWebView2 web, Dictionary<string, object> request)
    {
        object value;
        Guid id;
        if (!request.TryGetValue("id", out value) || !Guid.TryParse(value as string, out id)) return true;
        var requestId = id.ToString("D");
        try
        {
            var blocks = request.TryGetValue("blocks", out value) ? value as System.Collections.IList : null;
            if (blocks == null || blocks.Count == 0 || blocks.Count > 800)
                throw new InvalidDataException("双语段落数据无效。");
            var translate = request.TryGetValue("translate", out value) && Convert.ToBoolean(value);
            var preference = request.TryGetValue("preference", out value) ? Convert.ToString(value) : "large";
            var offline = translate && preference == "offline";
            var model = translate && !offline ? FindLocalLlmModel(preference) : null;
            if (translate && !offline && model == null) throw new InvalidOperationException(LocalLlmMissingMessage(preference));
            var payload = documentTranslationJson.Serialize(CleanDocumentTranslationValue(new Dictionary<string, object>
            {
                { "blocks", blocks },
                { "translate", translate },
                { "model", model ?? "" },
                { "engine", offline ? "offline" : "gguf" },
                { "source", request.TryGetValue("source", out value) ? value : "en" },
                { "target", request.TryGetValue("target", out value) ? value : "zh" }
            }));
            using (var cancel = new CancellationTokenSource())
            {
                if (bilingualPairRequests.ContainsKey(requestId))
                    throw new InvalidOperationException("此翻译请求正在处理。");
                bilingualPairRequests.Add(requestId, cancel);
                try
                {
                    await bilingualPairGate.WaitAsync(cancel.Token);
                    try
                    {
                        cancel.Token.ThrowIfCancellationRequested();
                        if (translate && pdf2zhRequestId == null) StopPdf2zhPage();
                        var process = EnsureDocumentWorker(ref bilingualPairWorker, "bilingual-book-worker.py",
                            "bilingual-book-maker-src", "bilingual_book_maker");
                        bilingualPairRequestId = requestId;
                        try
                        {
                            var result = await RunDocumentWorker(process, payload, "bilingual-pair-result",
                                TimeSpan.FromMinutes(12), "智能排版翻译超时，请重试。", message =>
                                {
                                    if (!cancel.IsCancellationRequested && message["type"] as string == "bilingual-pair-progress")
                                        PostDocumentWorkerMessage(web, new { type = "bilingual-pair-progress",
                                            id = requestId, pair = message["pair"] });
                                });
                            cancel.Token.ThrowIfCancellationRequested();
                            result["id"] = requestId;
                            PostDocumentWorkerMessage(web, result);
                        }
                        catch
                        {
                            if (process == bilingualPairWorker) StopBilingualPairWorker();
                            throw;
                        }
                        finally
                        {
                            bilingualPairRequestId = null;
                            if (process != bilingualPairWorker) process.Dispose();
                        }
                    }
                    finally { bilingualPairGate.Release(); }
                }
                catch
                {
                    if (!cancel.IsCancellationRequested) throw;
                }
                finally
                {
                    bilingualPairRequests.Remove(requestId);
                }
            }
        }
        catch (Exception error)
        {
            var detail = error.Message;
            PostWorkspaceMessage(web, new { type = "bilingual-pair-result", id = requestId,
                error = CleanUtf8Text(detail.Length > 800 ? detail.Substring(0, 800) : detail) });
        }
        return true;
    }

    private void PostDocumentWorkerMessage(CoreWebView2 web, object message)
    {
        if (!IsDisposed && !Disposing && string.Equals(web.Source, WorkspaceUrl, StringComparison.Ordinal))
            web.PostWebMessageAsJson(documentTranslationJson.Serialize(message));
    }

    private Process EnsureDocumentWorker(ref Process worker, string script, string dependency, string label)
    {
        if (worker != null && !worker.HasExited) return worker;
        if (worker != null)
        {
            documentWorkerDiagnostics.Remove(worker);
            worker.Dispose();
        }
        worker = null;
        var app = AppDomain.CurrentDomain.BaseDirectory;
        var runtime = Path.Combine(app, "video-runtime");
        var python = Path.Combine(runtime, "python.exe");
        var scriptPath = Path.Combine(runtime, "workers", script);
        if (!File.Exists(python) || !File.Exists(scriptPath) || !Directory.Exists(Path.Combine(runtime, dependency)))
            throw new InvalidOperationException(label + " 运行组件不完整，请重新安装完整版本。");
        var info = new ProcessStartInfo(python, "-B -X utf8 \"" + scriptPath + "\" --serve")
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
        var process = new Process { StartInfo = info };
        var diagnostics = new StringBuilder();
        process.ErrorDataReceived += (sender, args) =>
        {
            if (String.IsNullOrEmpty(args.Data)) return;
            lock (diagnostics)
            {
                diagnostics.AppendLine(args.Data);
                if (diagnostics.Length > 1024) diagnostics.Remove(0, diagnostics.Length - 1024);
            }
        };
        try
        {
            if (!process.Start()) throw new IOException("无法启动 " + label + "。");
            process.BeginErrorReadLine();
            documentWorkerDiagnostics.Add(process, diagnostics);
            worker = process;
            return process;
        }
        catch
        {
            StopDocumentWorker(process);
            process.Dispose();
            throw;
        }
    }

    private async Task<Dictionary<string, object>> RunDocumentWorker(Process process, string payload,
        string resultType, TimeSpan limit, string timeoutMessage, Action<Dictionary<string, object>> onProgress)
    {
        using (var deadline = new CancellationTokenSource())
        {
            var timeout = Task.Delay(limit, deadline.Token);
            try
            {
                // Keep stdin open between requests and bypass the framework's console encoding.
                var bytes = Encoding.UTF8.GetBytes(payload + "\n");
                var input = process.StandardInput.BaseStream;
                var written = input.WriteAsync(bytes, 0, bytes.Length);
                if (await Task.WhenAny(written, timeout) != written) throw new InvalidOperationException(timeoutMessage);
                await written;
                var flush = input.FlushAsync();
                if (await Task.WhenAny(flush, timeout) != flush) throw new InvalidOperationException(timeoutMessage);
                await flush;
                while (true)
                {
                    var read = process.StandardOutput.ReadLineAsync();
                    if (await Task.WhenAny(read, timeout) != read) throw new InvalidOperationException(timeoutMessage);
                    var line = await read;
                    if (line == null)
                    {
                        StringBuilder diagnostics;
                        var detail = "";
                        if (documentWorkerDiagnostics.TryGetValue(process, out diagnostics))
                            lock (diagnostics) { detail = diagnostics.ToString().Trim(); }
                        throw new IOException("PDF 翻译进程已退出。" + (detail.Length == 0 ? "" : " " + detail));
                    }
                    var message = documentTranslationJson.Deserialize<Dictionary<string, object>>(line);
                    object type;
                    if (message == null || !message.TryGetValue("type", out type))
                        throw new InvalidDataException("PDF 翻译进程返回了无法识别的结果。");
                    if (resultType == type as string) return message;
                    onProgress(message);
                }
            }
            finally { deadline.Cancel(); }
        }
    }

    private void StopDocumentWorker(Process process)
    {
        try { if (!process.HasExited) process.Kill(); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        finally { documentWorkerDiagnostics.Remove(process); }
    }

    private void StopBilingualPairWorker()
    {
        var process = bilingualPairWorker;
        bilingualPairWorker = null;
        if (process == null) return;
        StopDocumentWorker(process);
        if (bilingualPairRequestId == null) process.Dispose();
    }

    private void StopBilingualPairProcesses()
    {
        foreach (var request in bilingualPairRequests.Values) request.Cancel();
        StopBilingualPairWorker();
    }

    private void StopPdf2zh()
    {
        StopPdf2zhPage();
        CleanupPdf2zhPdf();
        if (pdf2zhIdleTimer != null)
        {
            pdf2zhIdleTimer.Dispose();
            pdf2zhIdleTimer = null;
        }
    }

    private void ClosePdf2zhDocument()
    {
        if (pdf2zhRequestId != null) StopPdf2zhPage();
        CleanupPdf2zhPdf();
        if (pdf2zhProcess == null) return;
        if (pdf2zhIdleTimer == null)
        {
            pdf2zhIdleTimer = new System.Windows.Forms.Timer { Interval = 60000 };
            pdf2zhIdleTimer.Tick += (sender, args) => StopPdf2zhPage();
        }
        pdf2zhIdleTimer.Start();
    }

    private void StopPdf2zhPage()
    {
        if (pdf2zhIdleTimer != null) pdf2zhIdleTimer.Stop();
        var process = pdf2zhProcess;
        pdf2zhProcess = null;
        pdf2zhRequestId = null;
        if (process == null) return;
        StopDocumentWorker(process);
        if (!pdf2zhWorkerDirectories.ContainsKey(process)) process.Dispose();
    }

    private void CleanupPdf2zhPdf()
    {
        try { if (pdf2zhStream != null) pdf2zhStream.Dispose(); } catch { }
        pdf2zhStream = null;
        if (pdf2zhDirectory != null && !pdf2zhWorkerDirectories.ContainsValue(pdf2zhDirectory))
            DeletePdf2zhDirectory(pdf2zhDirectory);
        pdf2zhDirectory = pdf2zhPath = pdf2zhDocumentId = null;
        pdf2zhExpected = pdf2zhReceived = 0;
        pdf2zhNextChunk = 0;
    }

    private static void DeletePdf2zhDirectory(string directory)
    {
        try { Directory.Delete(directory, true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static object CleanDocumentTranslationValue(object value)
    {
        var text = value as string;
        if (text != null) return CleanUtf8Text(text);
        var dictionary = value as IDictionary<string, object>;
        if (dictionary != null)
        {
            var clean = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var item in dictionary)
                clean[CleanUtf8Text(item.Key)] = CleanDocumentTranslationValue(item.Value);
            return clean;
        }
        var sequence = value as System.Collections.IEnumerable;
        if (sequence != null)
        {
            var clean = new List<object>();
            foreach (var item in sequence) clean.Add(CleanDocumentTranslationValue(item));
            return clean;
        }
        return value;
    }
}
