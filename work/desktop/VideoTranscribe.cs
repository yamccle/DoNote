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
    private Process videoTranscribeProcess;
    private string videoTranscribeId, videoTempPath, videoModel;
    private FileStream videoTempStream, videoTempLock;
    private System.Windows.Forms.Timer videoTransferTimer;
    private string videoTempDir;
    private long videoExpected, videoReceived;
    private bool videoRangeSource;
    private bool videoTransferPrepared;
    private long videoRangeOffset;
    private int videoRangeLength;
    private int videoNextChunk;
    private const int VideoChunkBytes = 256 * 1024;
    private const int VideoRangeBytes = 1024 * 1024;
    private const long VideoMaxBytes = 2L * 1024 * 1024 * 1024;
    private void CleanVideoTransfer() {
        StopVideoTransferTimer();
        if (videoTempStream != null) { try { videoTempStream.Dispose(); } catch {} videoTempStream = null; }
        if (videoTempPath != null) { try { File.Delete(videoTempPath); } catch {} videoTempPath = null; }
        if (videoTempLock != null) { try { videoTempLock.Dispose(); } catch {} videoTempLock = null; }
        if (videoTempDir != null) { try { File.Delete(Path.Combine(videoTempDir, "active.lock")); Directory.Delete(videoTempDir); } catch {} videoTempDir = null; }
        videoTranscribeId = null; videoModel = null; videoExpected = videoReceived = 0; videoNextChunk = 0;
        videoRangeSource = false; videoTransferPrepared = false; videoRangeLength = 0;
    }
    private void StopVideoTransferTimer() {
        if (videoTransferTimer == null) return;
        videoTransferTimer.Stop(); videoTransferTimer.Dispose(); videoTransferTimer = null;
    }
    private void StartVideoTransferTimer(CoreWebView2 web, string requestId) {
        StopVideoTransferTimer();
        var timer = new System.Windows.Forms.Timer { Interval = 90000 };
        videoTransferTimer = timer;
        timer.Tick += (sender, args) => {
            if (videoTransferTimer != timer || videoTranscribeId != requestId) return;
            if (videoTranscribeProcess != null)
            {
                try { videoTranscribeProcess.Kill(); } catch {}
                StopVideoTransferTimer();
                VideoTranscribeError(web, requestId, "读取视频音轨超时，可保留已经生成的字幕。");
                return;
            }
            CleanVideoTransfer();
            VideoTranscribeError(web, requestId, "视频传输中断，临时文件已清理，请重试。");
        };
        timer.Start();
    }
    private void RefreshVideoTransferTimer() {
        if (videoTransferTimer == null) return;
        videoTransferTimer.Stop(); videoTransferTimer.Start();
    }
    private void CleanStaleVideoTransfers(string root) {
        foreach (string dir in Directory.GetDirectories(root, "dnt-*")) {
            Guid token; string name = Path.GetFileName(dir);
            if (name.Length != 36 || !Guid.TryParseExact(name.Substring(4), "N", out token)) continue;
            string lockPath = Path.Combine(dir, "active.lock");
            try {
                using (var guard = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
                    string video = Path.Combine(dir, "source.bin");
                    if (File.Exists(video)) File.Delete(video);
                }
                File.Delete(lockPath); Directory.Delete(dir);
            } catch (IOException) {} catch (UnauthorizedAccessException) {}
        }
    }
    private void VideoAck(CoreWebView2 web, string id, int seq) {
        if (!IsDisposed && !Disposing) PostWorkspaceMessage(web, new { type = "video-transcribe-ack", id, seq, source = videoRangeSource ? "range-v1" : "" });
    }
    private async Task<bool> HandleVideoTranscribe(CoreWebView2 web, string requestJson)
    {
        const int maxMessageLength = 1400000;
        if (requestJson.Length > maxMessageLength || requestJson.IndexOf("\"video-transcribe", StringComparison.Ordinal) < 0) return false;
        Dictionary<string, object> request;
        try { request = new JavaScriptSerializer { MaxJsonLength = maxMessageLength }.Deserialize<Dictionary<string, object>>(requestJson); }
        catch { return false; }
        object value;
        if (request == null || !request.TryGetValue("type", out value)) return false;
        string type = value as string;
        if (type != "video-transcribe" && type != "video-transcribe-cancel" && type != "video-transcribe-chunk" &&
            type != "video-transcribe-finish" && type != "video-transcribe-range") return false;
        Guid id;
        if (!request.TryGetValue("id", out value) || !Guid.TryParse(value as string, out id)) return true;
        string requestId = (string)value;
        if (type == "video-transcribe-cancel") {
            if (videoTranscribeId == requestId) {
                if (videoTranscribeProcess != null) { try { videoTranscribeProcess.Kill(); } catch {} }
                else CleanVideoTransfer();
            }
            return true;
        }
        if (type == "video-transcribe") {
            if (videoTranscribeId != null) { VideoTranscribeError(web, requestId, "已有转录任务正在运行。"); return true; }
            try {
                long size = request.TryGetValue("size", out value) ? Convert.ToInt64(value) : 0;
                if (size <= 0 || size > VideoMaxBytes) throw new InvalidDataException("视频大小无效或超过 2 GiB。 ");
                string model = request.TryGetValue("model", out value) ? value as string : null;
                if (model != "base" && model != "small" && model != "large-v3" && model != "large-v3-turbo") throw new InvalidDataException("识别模型无效。");
                videoTranscribeId = requestId; videoExpected = size; videoModel = model;
                videoRangeSource = request.TryGetValue("source", out value) && (value as string) == "range-v1";
                if (!videoRangeSource)
                {
                    string root = Path.Combine(dataRoot, "video-transcribe-tmp");
                    Directory.CreateDirectory(root); CleanStaleVideoTransfers(root);
                    videoTempDir = Path.Combine(root, "dnt-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(videoTempDir);
                    videoTempLock = new FileStream(Path.Combine(videoTempDir, "active.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
                    videoTempPath = Path.Combine(videoTempDir, "source.bin");
                    videoTempStream = new FileStream(videoTempPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, VideoChunkBytes, FileOptions.SequentialScan);
                }
                videoTransferPrepared = true;
                StartVideoTransferTimer(web, requestId);
                VideoAck(web, requestId, -1);
            } catch (Exception error) { CleanVideoTransfer(); VideoTranscribeError(web, requestId, "无法准备视频：" + error.Message); }
            return true;
        }
        if (videoTranscribeId != requestId) return true;
        if (type == "video-transcribe-range")
        {
            var process = videoTranscribeProcess;
            if (process == null || !videoRangeSource || videoRangeLength == 0) return true;
            try
            {
                long offset = request.TryGetValue("offset", out value) ? Convert.ToInt64(value) : -1;
                if (offset != videoRangeOffset) return true;
                var encoded = request.TryGetValue("data", out value) ? value as string : null;
                int length = videoRangeLength;
                if (String.IsNullOrEmpty(encoded) || encoded.Length != ((length + 2) / 3) * 4)
                    throw new InvalidDataException("无法读取当前视频的数据。");
                var bytes = Convert.FromBase64String(encoded);
                if (bytes.Length != length) throw new InvalidDataException("视频数据不完整。");
                videoRangeLength = 0;
                StopVideoTransferTimer();
                await process.StandardInput.BaseStream.WriteAsync(bytes, 0, length);
            }
            catch (Exception error)
            {
                try { process.Kill(); } catch {}
                VideoTranscribeError(web, requestId, "无法读取视频音轨：" + error.Message);
            }
            return true;
        }
        if (!videoTransferPrepared || videoTranscribeProcess != null) return true;
        if (type == "video-transcribe-chunk") {
            if (videoTempStream == null) return true;
            try {
                int seq = request.TryGetValue("seq", out value) ? Convert.ToInt32(value) : -1;
                if (seq != videoNextChunk) throw new InvalidDataException("视频数据顺序错误。");
                string encoded = request.TryGetValue("data", out value) ? value as string : null;
                if (String.IsNullOrEmpty(encoded) || encoded.Length > 349528) throw new InvalidDataException("视频数据无效。");
                byte[] chunk = Convert.FromBase64String(encoded);
                if (chunk.Length == 0 || chunk.Length > VideoChunkBytes || videoReceived + chunk.Length > videoExpected) throw new InvalidDataException("视频数据大小错误。");
                videoTempStream.Write(chunk, 0, chunk.Length); videoReceived += chunk.Length; videoNextChunk++;
                RefreshVideoTransferTimer();
                VideoAck(web, requestId, seq);
            } catch (Exception error) { CleanVideoTransfer(); VideoTranscribeError(web, requestId, "传送视频失败：" + error.Message); }
            return true;
        }
        if (!videoRangeSource && videoReceived != videoExpected) { CleanVideoTransfer(); VideoTranscribeError(web, requestId, "视频传输不完整，请重试。"); return true; }
        videoTransferPrepared = false;
        StopVideoTransferTimer();
        if (videoTempStream != null) { videoTempStream.Dispose(); videoTempStream = null; }
        string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "video-runtime", "workers", "video-transcribe.py");
        string python = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "video-runtime", "python.exe");
        if (!File.Exists(script) || !File.Exists(python)) { CleanVideoTransfer(); VideoTranscribeError(web, requestId, "本地识别组件缺失，请解压完整安装包。"); return true; }
        try {
            string input = videoRangeSource ? "-" : "\"" + videoTempPath + "\"";
            string arguments = "-B -u \"" + script + "\" " + input + " " + videoModel + " " + requestId;
            if (videoRangeSource) arguments += " " + videoExpected.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var info = new ProcessStartInfo(python, arguments) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = videoRangeSource, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
            info.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            info.EnvironmentVariables["DONOTE_VIDEO_DEPS"] = Path.Combine(dataRoot, "video-deps");
            using (var process = new Process { StartInfo = info }) {
                videoTranscribeProcess = process;
                if (!process.Start()) throw new IOException("无法启动本地识别组件。");
                PostWorkspaceMessage(web, new { type = "video-transcribe-progress", id = requestId, status = "正在启动识别组件…" });
                var output = process.StandardOutput.ReadToEndAsync();
                var errors = ReadVideoProgress(process, web, requestId);
                if (await Task.WhenAny(output, Task.Delay(TimeSpan.FromHours(6))) != output) {
                    try { process.Kill(); } catch {} VideoTranscribeError(web, requestId, "识别超时，任务已停止。");
                } else {
                    string result = await output; string stderr = await errors;
                    if (!IsDisposed && !Disposing && result.StartsWith("{\"type\": \"video-transcribe-result\"", StringComparison.Ordinal)) web.PostWebMessageAsJson(result);
                    else VideoTranscribeError(web, requestId, "识别已取消或无法启动本地识别组件。" + (stderr.IndexOf("No module named", StringComparison.OrdinalIgnoreCase) >= 0 ? "识别组件缺少依赖，请重新解压完整安装包。" : ""));
                }
            }
        } catch (Exception error) { VideoTranscribeError(web, requestId, "无法运行本地转录：" + error.Message); }
        finally { videoTranscribeProcess = null; CleanVideoTransfer(); }
        return true;
    }
    private async Task<string> ReadVideoProgress(Process process, CoreWebView2 web, string requestId) {
        var errors = new StringBuilder(); string line;
        const string prefix = "DONOTE_PROGRESS:";
        var parser = new JavaScriptSerializer { MaxJsonLength = 65536 };
        while ((line = await process.StandardError.ReadLineAsync()) != null) {
            if (line.StartsWith(prefix, StringComparison.Ordinal) && line.Length < 65536) {
                if (IsDisposed || Disposing || videoTranscribeId != requestId) continue;
                string jsonLine = line.Substring(prefix.Length);
                try
                {
                    if (jsonLine.StartsWith("{\"type\": \"video-transcribe-range-request\"", StringComparison.Ordinal))
                    {
                        var message = parser.Deserialize<Dictionary<string, object>>(jsonLine);
                        long offset = Convert.ToInt64(message["offset"]);
                        int length = Convert.ToInt32(message["length"]);
                        if (!videoRangeSource || videoRangeLength != 0 || offset < 0 || length < 1 ||
                            length > VideoRangeBytes || offset > videoExpected - length)
                            throw new InvalidDataException("本地识别组件请求的视频范围无效。");
                        videoRangeOffset = offset;
                        videoRangeLength = length;
                        StartVideoTransferTimer(web, requestId);
                    }
                    web.PostWebMessageAsJson(jsonLine);
                }
                catch (Exception error)
                {
                    try { process.Kill(); } catch {}
                    VideoTranscribeError(web, requestId, "无法继续读取视频音轨：" + error.Message);
                    break;
                }
            } else if (errors.Length < 8192) errors.AppendLine(line);
        }
        return errors.ToString();
    }
    private void VideoTranscribeError(CoreWebView2 web, string id, string message) { if (!IsDisposed && !Disposing) PostWorkspaceMessage(web, new { type = "video-transcribe-result", id, error = message }); }
    private void StopVideoTranscription() { if (videoTranscribeProcess != null) try { videoTranscribeProcess.Kill(); } catch {} CleanVideoTransfer(); }
}
