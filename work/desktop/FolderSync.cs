/*
 * [INPUT]: 接收工作台选择的云盘同步文件夹，以及分块写入的记录和附件。
 * [OUTPUT]: 保存文件夹路径，列出 DoNote 子目录，按块读写文件，并把外部变更通知工作台。
 * [POS]: Windows 宿主的文件夹对齐。云盘客户端负责外网传输。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

internal sealed partial class WorkspaceWindow
{
    private const int FolderSyncChunkBytes = 480 * 1024;
    private const int FolderSyncPageSize = 200;
    private const int FolderSyncTextLimit = 700000;
    private readonly JavaScriptSerializer folderSyncJson = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
    private readonly object folderSyncGate = new object();
    private readonly Dictionary<string, DateTime> folderSyncQuietUntil = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
    private FileSystemWatcher folderSyncWatcher;
    private System.Threading.Timer folderSyncDebounce;
    private string folderSyncDirectory;
    private FileStream folderSyncPutStream;
    private string folderSyncPutFinal;
    private string folderSyncPutPending;
    private long folderSyncPutExpected;
    private long folderSyncPutWritten;
    private int folderSyncPutSeq;
    private FileStream folderSyncGetStream;
    private int folderSyncGetSeq;

    private string FolderSyncSettingsPath
    {
        get { return Path.Combine(dataRoot, "FolderSync.txt"); }
    }

    private string ReadFolderSyncDirectory()
    {
        if (!File.Exists(FolderSyncSettingsPath)) return "";
        var folder = File.ReadAllText(FolderSyncSettingsPath, Encoding.UTF8).Trim();
        if (folder.Length == 0 || !Directory.Exists(folder)) return "";
        return folder;
    }

    private void RememberFolderSyncDirectory(string folder)
    {
        var pending = FolderSyncSettingsPath + "." + Guid.NewGuid().ToString("N") + ".pending";
        File.WriteAllText(pending, folder, new UTF8Encoding(false));
        if (File.Exists(FolderSyncSettingsPath)) File.Replace(pending, FolderSyncSettingsPath, null);
        else File.Move(pending, FolderSyncSettingsPath);
        StartFolderSyncWatch(folder);
    }

    private void StartFolderSyncWatch(string folder)
    {
        StopFolderSyncWatch();
        if (String.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return;
        var syncDir = Path.Combine(folder, "DoNote");
        Directory.CreateDirectory(syncDir);
        Directory.CreateDirectory(Path.Combine(syncDir, "records"));
        Directory.CreateDirectory(Path.Combine(syncDir, "tombstones"));
        Directory.CreateDirectory(Path.Combine(syncDir, "annotations"));
        Directory.CreateDirectory(Path.Combine(syncDir, "files"));
        folderSyncDirectory = syncDir;
        folderSyncWatcher = new FileSystemWatcher(syncDir);
        folderSyncWatcher.IncludeSubdirectories = true;
        folderSyncWatcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.CreationTime;
        folderSyncWatcher.Changed += OnFolderSyncChanged;
        folderSyncWatcher.Created += OnFolderSyncChanged;
        folderSyncWatcher.Renamed += OnFolderSyncChanged;
        folderSyncWatcher.EnableRaisingEvents = true;
    }

    private void StopFolderSyncWatch()
    {
        CancelFolderSyncTransfer();
        if (folderSyncWatcher == null) return;
        folderSyncWatcher.EnableRaisingEvents = false;
        folderSyncWatcher.Dispose();
        folderSyncWatcher = null;
        lock (folderSyncGate)
        {
            if (folderSyncDebounce != null) folderSyncDebounce.Dispose();
            folderSyncDebounce = null;
        }
    }

    private void OnFolderSyncChanged(object sender, FileSystemEventArgs args)
    {
        var path = args.FullPath;
        if (path.EndsWith(".partial", StringComparison.OrdinalIgnoreCase)) return;
        lock (folderSyncGate)
        {
            DateTime until;
            if (folderSyncQuietUntil.TryGetValue(path, out until) && DateTime.UtcNow < until) return;
            if (folderSyncDebounce == null)
                folderSyncDebounce = new System.Threading.Timer(delegate { NotifyFolderSync(); }, null, 800, Timeout.Infinite);
            else
                folderSyncDebounce.Change(800, Timeout.Infinite);
        }
    }

    private void NotifyFolderSync()
    {
        if (IsDisposed || Disposing || !IsHandleCreated) return;
        try
        {
            BeginInvoke(new MethodInvoker(delegate
            {
                var web = browser.CoreWebView2;
                if (web == null) return;
                PostFolderSync(web, new { type = "folder-sync-changed" });
            }));
        }
        catch (InvalidOperationException) { }
    }

    private void NoteFolderSyncWrite(string fullPath)
    {
        lock (folderSyncGate)
        {
            folderSyncQuietUntil[fullPath] = DateTime.UtcNow.AddSeconds(3);
            if (folderSyncQuietUntil.Count <= 500) return;
            folderSyncQuietUntil.Clear();
            folderSyncQuietUntil[fullPath] = DateTime.UtcNow.AddSeconds(3);
        }
    }

    private void CancelFolderSyncTransfer()
    {
        if (folderSyncPutStream != null)
        {
            folderSyncPutStream.Dispose();
            folderSyncPutStream = null;
        }
        if (!String.IsNullOrEmpty(folderSyncPutPending))
        {
            try { if (File.Exists(folderSyncPutPending)) File.Delete(folderSyncPutPending); }
            catch (IOException) { }
            folderSyncPutPending = null;
        }
        folderSyncPutFinal = null;
        if (folderSyncGetStream != null)
        {
            folderSyncGetStream.Dispose();
            folderSyncGetStream = null;
        }
    }

    private static bool FolderSyncGuidName(string name)
    {
        Guid parsed;
        return !String.IsNullOrEmpty(name) && Guid.TryParse(name, out parsed) && name.IndexOfAny(Path.GetInvalidFileNameChars()) < 0;
    }

    private static bool FolderSyncBlobName(string name)
    {
        if (String.IsNullOrEmpty(name) || name.Length != 64) return false;
        for (var i = 0; i < name.Length; i++)
        {
            var ch = name[i];
            if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F'))) return false;
        }
        return true;
    }

    private string FolderSyncChild(string kind, string name, bool createDirectory)
    {
        if (String.IsNullOrEmpty(folderSyncDirectory)) throw new InvalidOperationException("请先选择同步文件夹。");
        string relative;
        if (kind == "library") relative = "library.json";
        else if (kind == "record" || kind == "tombstone" || kind == "annotation")
        {
            if (!FolderSyncGuidName(name)) throw new InvalidDataException("同步记录名称无效。");
            var folder = kind == "record" ? "records" : kind == "tombstone" ? "tombstones" : "annotations";
            relative = Path.Combine(folder, name + ".json");
        }
        else if (kind == "blob")
        {
            if (!FolderSyncBlobName(name)) throw new InvalidDataException("同步附件名称无效。");
            relative = Path.Combine("files", name.ToLowerInvariant());
        }
        else throw new InvalidOperationException("文件夹同步类型未知。");
        var root = Path.GetFullPath(folderSyncDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(Path.Combine(folderSyncDirectory, relative));
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("同步路径无效。");
        if (createDirectory) Directory.CreateDirectory(Path.GetDirectoryName(full));
        return full;
    }

    private void AddFolderSyncFile(List<object> list, string kind, string name, string full, ref bool conflicts)
    {
        if (!File.Exists(full)) return;
        var info = new FileInfo(full);
        if (info.Name.IndexOf("conflict", StringComparison.OrdinalIgnoreCase) >= 0) conflicts = true;
        list.Add(new Dictionary<string, object> {
            { "kind", kind },
            { "name", name },
            { "bytes", info.Length },
            { "mtime", info.LastWriteTimeUtc.Ticks.ToString() }
        });
    }

    private object[] SnapshotFolderSync(out bool conflicts)
    {
        conflicts = false;
        var list = new List<object>();
        var conflicted = false;
        AddFolderSyncFile(list, "library", "", Path.Combine(folderSyncDirectory, "library.json"), ref conflicted);
        AddFolderSyncDirectory(list, "record", "records", true, ref conflicted);
        AddFolderSyncDirectory(list, "tombstone", "tombstones", true, ref conflicted);
        AddFolderSyncDirectory(list, "annotation", "annotations", true, ref conflicted);
        AddFolderSyncDirectory(list, "blob", "files", false, ref conflicted);
        conflicts = conflicted;
        if (list.Count > 20000) throw new InvalidDataException("同步文件夹里的文件过多。");
        return list.ToArray();
    }

    private void AddFolderSyncDirectory(List<object> list, string kind, string folder, bool jsonName, ref bool conflicts)
    {
        var directory = Path.Combine(folderSyncDirectory, folder);
        if (!Directory.Exists(directory)) return;
        foreach (var full in Directory.GetFiles(directory))
        {
            var fileName = Path.GetFileName(full);
            if (fileName.EndsWith(".partial", StringComparison.OrdinalIgnoreCase)) continue;
            if (fileName.IndexOf("conflict", StringComparison.OrdinalIgnoreCase) >= 0) conflicts = true;
            string name;
            if (jsonName)
            {
                if (!fileName.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) continue;
                name = Path.GetFileNameWithoutExtension(fileName);
                if (!FolderSyncGuidName(name)) continue;
            }
            else
            {
                if (!FolderSyncBlobName(fileName)) continue;
                name = fileName.ToLowerInvariant();
            }
            AddFolderSyncFile(list, kind, name, full, ref conflicts);
        }
    }

    private void PostFolderSync(CoreWebView2 web, object message)
    {
        if (web == null || IsDisposed || Disposing) return;
        web.PostWebMessageAsJson(folderSyncJson.Serialize(message));
    }

    private static long FolderSyncLong(Dictionary<string, object> request, string key)
    {
        object value;
        if (!request.TryGetValue(key, out value) || value == null) return -1;
        return Convert.ToInt64(value);
    }

    private void FinishFolderSyncPut()
    {
        if (folderSyncPutStream == null || folderSyncPutWritten != folderSyncPutExpected)
            throw new InvalidDataException("同步文件不完整。");
        folderSyncPutStream.Flush(true);
        folderSyncPutStream.Dispose();
        folderSyncPutStream = null;
        if (File.Exists(folderSyncPutFinal)) File.Replace(folderSyncPutPending, folderSyncPutFinal, null);
        else File.Move(folderSyncPutPending, folderSyncPutFinal);
        NoteFolderSyncWrite(folderSyncPutFinal);
        folderSyncPutPending = null;
        folderSyncPutFinal = null;
    }

    private bool HandleFolderSyncMessage(CoreWebView2 web, string requestJson)
    {
        if (requestJson.IndexOf("folder-sync", StringComparison.Ordinal) < 0) return false;
        Dictionary<string, object> request;
        try { request = folderSyncJson.Deserialize<Dictionary<string, object>>(requestJson); }
        catch { return false; }
        if (request == null || CloudValue(request, "type") != "folder-sync") return false;
        Guid requestId;
        if (!Guid.TryParse(CloudValue(request, "id"), out requestId)) return true;
        var id = requestId.ToString("D");
        var action = CloudValue(request, "action");
        try
        {
            if (action == "status")
            {
                var folder = ReadFolderSyncDirectory();
                if (folder.Length > 0) StartFolderSyncWatch(folder);
                PostFolderSync(web, new { type = "folder-sync-result", id, folder });
            }
            else if (action == "choose")
            {
                CancelFolderSyncTransfer();
                var chosen = ChooseCloudFolder("选择云盘客户端已经在同步的文件夹");
                if (chosen != null) RememberFolderSyncDirectory(chosen);
                PostFolderSync(web, new { type = "folder-sync-result", id, folder = chosen ?? "", cancelled = chosen == null });
            }
            else if (action == "list")
            {
                var folder = ReadFolderSyncDirectory();
                if (folder.Length == 0) throw new InvalidOperationException("请先选择同步文件夹。");
                if (String.IsNullOrEmpty(folderSyncDirectory)) StartFolderSyncWatch(folder);
                bool conflicts;
                var files = SnapshotFolderSync(out conflicts);
                var cursor = (int)FolderSyncLong(request, "cursor");
                if (cursor < 0) cursor = 0;
                var page = new List<object>();
                var end = Math.Min(files.Length, cursor + FolderSyncPageSize);
                for (var i = cursor; i < end; i++) page.Add(files[i]);
                var next = end < files.Length ? end : -1;
                PostFolderSync(web, new { type = "folder-sync-result", id, files = page.ToArray(), next, conflicts });
            }
            else if (action == "read")
            {
                var full = FolderSyncChild(CloudValue(request, "kind"), CloudValue(request, "name"), false);
                if (!File.Exists(full)) PostFolderSync(web, new { type = "folder-sync-result", id, body = "" });
                else
                {
                    var info = new FileInfo(full);
                    if (info.Length > FolderSyncTextLimit) throw new InvalidDataException("这条记录过大，请改用分块读取。");
                    PostFolderSync(web, new { type = "folder-sync-result", id, body = File.ReadAllText(full, Encoding.UTF8) });
                }
            }
            else if (action == "write")
            {
                var body = CloudValue(request, "body") ?? "";
                if (body.Length > FolderSyncTextLimit) throw new InvalidDataException("这条记录过大，请改用分块写入。");
                var full = FolderSyncChild(CloudValue(request, "kind"), CloudValue(request, "name"), true);
                var pending = full + "." + Guid.NewGuid().ToString("N") + ".partial";
                File.WriteAllText(pending, body, new UTF8Encoding(false));
                if (File.Exists(full)) File.Replace(pending, full, null);
                else File.Move(pending, full);
                NoteFolderSyncWrite(full);
                PostFolderSync(web, new { type = "folder-sync-result", id, written = true });
            }
            else if (action == "remove")
            {
                var full = FolderSyncChild(CloudValue(request, "kind"), CloudValue(request, "name"), false);
                if (File.Exists(full)) File.Delete(full);
                NoteFolderSyncWrite(full);
                PostFolderSync(web, new { type = "folder-sync-result", id, removed = true });
            }
            else if (action == "put-start")
            {
                if (folderSyncPutStream != null) throw new InvalidOperationException("上一个同步文件尚未写完。");
                var size = FolderSyncLong(request, "size");
                if (size < 0 || size > 2L * 1024 * 1024 * 1024) throw new InvalidDataException("同步文件大小无效。");
                folderSyncPutFinal = FolderSyncChild(CloudValue(request, "kind"), CloudValue(request, "name"), true);
                folderSyncPutPending = folderSyncPutFinal + "." + Guid.NewGuid().ToString("N") + ".partial";
                folderSyncPutExpected = size;
                folderSyncPutWritten = 0;
                folderSyncPutSeq = 0;
                folderSyncPutStream = new FileStream(folderSyncPutPending, FileMode.CreateNew, FileAccess.Write, FileShare.None, FolderSyncChunkBytes, FileOptions.SequentialScan);
                PostFolderSync(web, new { type = "folder-sync-result", id, started = true });
            }
            else if (action == "put-chunk")
            {
                if (folderSyncPutStream == null) throw new InvalidOperationException("没有正在写入的同步文件。");
                var seq = (int)FolderSyncLong(request, "seq");
                if (seq != folderSyncPutSeq) throw new InvalidDataException("同步数据顺序错误。");
                var encoded = CloudValue(request, "data");
                if (String.IsNullOrEmpty(encoded) || encoded.Length > 900000) throw new InvalidDataException("同步数据块无效。");
                var bytes = Convert.FromBase64String(encoded);
                if (bytes.Length <= 0 || bytes.Length > FolderSyncChunkBytes || folderSyncPutWritten + bytes.Length > folderSyncPutExpected)
                    throw new InvalidDataException("同步数据大小错误。");
                folderSyncPutStream.Write(bytes, 0, bytes.Length);
                folderSyncPutWritten += bytes.Length;
                folderSyncPutSeq++;
                PostFolderSync(web, new { type = "folder-sync-result", id, seq });
            }
            else if (action == "put-finish")
            {
                FinishFolderSyncPut();
                PostFolderSync(web, new { type = "folder-sync-result", id, written = true });
            }
            else if (action == "get-start")
            {
                if (folderSyncGetStream != null)
                {
                    folderSyncGetStream.Dispose();
                    folderSyncGetStream = null;
                }
                var full = FolderSyncChild(CloudValue(request, "kind"), CloudValue(request, "name"), false);
                if (!File.Exists(full)) throw new FileNotFoundException("同步文件不存在。");
                folderSyncGetStream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, FolderSyncChunkBytes, FileOptions.SequentialScan);
                folderSyncGetSeq = 0;
                PostFolderSync(web, new { type = "folder-sync-result", id, size = folderSyncGetStream.Length });
            }
            else if (action == "get-chunk")
            {
                if (folderSyncGetStream == null) throw new InvalidOperationException("没有正在读取的同步文件。");
                var seq = (int)FolderSyncLong(request, "seq");
                if (seq != folderSyncGetSeq) throw new InvalidDataException("同步数据顺序错误。");
                var buffer = new byte[FolderSyncChunkBytes];
                var count = folderSyncGetStream.Read(buffer, 0, buffer.Length);
                folderSyncGetSeq++;
                var done = folderSyncGetStream.Position >= folderSyncGetStream.Length;
                var data = count == 0 ? "" : Convert.ToBase64String(buffer, 0, count);
                if (done)
                {
                    folderSyncGetStream.Dispose();
                    folderSyncGetStream = null;
                }
                PostFolderSync(web, new { type = "folder-sync-result", id, seq, data, done });
            }
            else if (action == "cancel")
            {
                CancelFolderSyncTransfer();
                PostFolderSync(web, new { type = "folder-sync-result", id, cancelled = true });
            }
            else throw new InvalidOperationException("文件夹同步操作未知。");
        }
        catch (Exception error)
        {
            CancelFolderSyncTransfer();
            var message = error is InvalidOperationException || error is InvalidDataException || error is IOException || error is UnauthorizedAccessException
                ? error.Message : "文件夹同步失败，请重试。";
            if (error is IOException) message = "同步文件暂时无法读写。请等云盘客户端完成当前同步后再试。";
            PostFolderSync(web, new { type = "folder-sync-result", id, error = message });
        }
        return true;
    }
}
