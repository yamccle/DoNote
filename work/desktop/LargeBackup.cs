/*
 * [INPUT]: 接收目录授权和已分块的备份附件。
 * [OUTPUT]: 在本机写入带清单的备份目录，并向云备份移交已完成快照。
 * [POS]: 本机和云备份共用的原生写入器。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

internal sealed partial class WorkspaceWindow
{
    private const int NativeBackupChunkBytes = 1024 * 1024;
    private readonly JavaScriptSerializer nativeBackupJson = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    private string nativeBackupChosenRoot;
    private string nativeBackupTarget;
    private string nativeBackupRelative;
    private FileStream nativeBackupStream;
    private long nativeBackupExpected;
    private long nativeBackupWritten;
    private int nativeBackupNextChunk;

    private bool HandleLargeBackupMessage(CoreWebView2 web, string requestJson)
    {
        Dictionary<string, object> request;
        try { request = nativeBackupJson.Deserialize<Dictionary<string, object>>(requestJson); }
        catch { return false; }
        if (request == null) return false;
        object value;
        if (!request.TryGetValue("type", out value)) return false;
        var type = value as string;
        if (type != "native-backup-choose" && type != "native-backup-start" &&
            type != "native-backup-file-start" && type != "native-backup-chunk" &&
            type != "native-backup-file-finish" && type != "native-backup-finish" &&
            type != "native-backup-cancel" && type != "native-storage-space") return false;

        Guid requestId;
        if (!request.TryGetValue("id", out value) || !Guid.TryParse(value as string, out requestId)) return true;
        var id = requestId.ToString("D");
        if (type == "native-backup-choose" && (cloudStage != null || cloudBackupCancellation != null))
        {
            PostWorkspaceMessage(web, new { type = "native-backup-result", id, error = "云备份进行中，请等待或取消该任务。" });
            return true;
        }
        try
        {
            if (type == "native-storage-space")
            {
                PostWorkspaceMessage(web, new { type = "native-backup-result", id, freeBytes = AvailableBytes(dataRoot) });
                return true;
            }
            if (type == "native-backup-choose")
            {
                StopNativeBackup(false);
                using (var picker = new System.Windows.Forms.FolderBrowserDialog
                {
                    Description = "选择大文件备份的目标文件夹",
                    ShowNewFolderButton = true
                })
                {
                    if (picker.ShowDialog(this) != System.Windows.Forms.DialogResult.OK)
                    {
                        PostWorkspaceMessage(web, new { type = "native-backup-result", id, cancelled = true });
                        return true;
                    }
                    nativeBackupChosenRoot = Path.GetFullPath(picker.SelectedPath).TrimEnd('\\');
                    PostWorkspaceMessage(web, new
                    {
                        type = "native-backup-result",
                        id,
                        path = nativeBackupChosenRoot,
                        freeBytes = AvailableBytes(nativeBackupChosenRoot)
                    });
                }
                return true;
            }
            if (type == "native-backup-cancel")
            {
                StopNativeBackup(true);
                PostWorkspaceMessage(web, new { type = "native-backup-result", id, cancelled = true });
                return true;
            }
            if (type == "native-backup-start")
            {
                if (String.IsNullOrEmpty(nativeBackupChosenRoot) || !Directory.Exists(nativeBackupChosenRoot))
                    throw new InvalidOperationException("请先选择备份目标文件夹。");
                var folderName = request.TryGetValue("folderName", out value) ? Convert.ToString(value) : "";
                if (!System.Text.RegularExpressions.Regex.IsMatch(folderName, @"\A[A-Za-z0-9._\-\u4e00-\u9fff ]{1,120}\z"))
                    throw new InvalidDataException("备份文件夹名称无效。");
                var cloud = IsCloudBackupRoot(nativeBackupChosenRoot);
                if (cloud && !CloudBackupTransport.ValidName(folderName))
                    throw new InvalidDataException("云备份版本名称无效。");
                var expected = request.TryGetValue("estimatedBytes", out value) ? Convert.ToInt64(value) : 0;
                if (expected <= 0) throw new InvalidDataException("无法估算备份大小。");
                var reserve = 512L * 1024 * 1024;
                var free = AvailableBytes(nativeBackupChosenRoot);
                var required = checked(expected * (cloud ? 2L : 1L) + reserve);
                if (free >= 0 && free < required)
                    throw new InvalidOperationException("目标磁盘空间不足。预计需要 " + SizeText(required)
                        + "，当前可用 " + SizeText(free) + "。");
                var chosenRoot = nativeBackupChosenRoot;
                StopNativeBackup(false);
                nativeBackupChosenRoot = chosenRoot;
                var candidate = Path.Combine(chosenRoot, folderName);
                if (Directory.Exists(candidate)) throw new IOException("备份文件夹已存在，请重试以生成新的独立快照。");
                Directory.CreateDirectory(candidate);
                nativeBackupTarget = candidate;
                PostWorkspaceMessage(web, new { type = "native-backup-result", id, path = nativeBackupTarget, freeBytes = free });
                return true;
            }
            if (String.IsNullOrEmpty(nativeBackupTarget) || !Directory.Exists(nativeBackupTarget))
                throw new InvalidOperationException("备份任务尚未开始。");
            if (type == "native-backup-file-start")
            {
                if (nativeBackupStream != null) throw new InvalidOperationException("上一个备份文件尚未结束。");
                nativeBackupRelative = request.TryGetValue("path", out value) ? Convert.ToString(value) : "";
                nativeBackupExpected = request.TryGetValue("size", out value) ? Convert.ToInt64(value) : -1;
                if (nativeBackupExpected < 0 || nativeBackupExpected > 2L * 1024 * 1024 * 1024)
                    throw new InvalidDataException("备份文件大小无效。");
                var safe = UpdatePackage.SafePath(nativeBackupRelative);
                var target = Path.GetFullPath(Path.Combine(nativeBackupTarget, safe));
                if (!target.StartsWith(nativeBackupTarget + "\\", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("备份文件路径无效。");
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                nativeBackupStream = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                    NativeBackupChunkBytes, FileOptions.SequentialScan);
                nativeBackupWritten = 0;
                nativeBackupNextChunk = 0;
                PostWorkspaceMessage(web, new { type = "native-backup-result", id, started = true });
                return true;
            }
            if (type == "native-backup-chunk")
            {
                if (nativeBackupStream == null) throw new InvalidOperationException("没有正在写入的备份文件。");
                var seq = request.TryGetValue("seq", out value) ? Convert.ToInt32(value) : -1;
                if (seq != nativeBackupNextChunk) throw new InvalidDataException("备份数据顺序错误。");
                var encoded = request.TryGetValue("data", out value) ? Convert.ToString(value) : "";
                if (String.IsNullOrEmpty(encoded) || encoded.Length > 1500000) throw new InvalidDataException("备份数据块无效。");
                var bytes = Convert.FromBase64String(encoded);
                if (bytes.Length <= 0 || bytes.Length > NativeBackupChunkBytes || nativeBackupWritten + bytes.Length > nativeBackupExpected)
                    throw new InvalidDataException("备份数据大小错误。");
                nativeBackupStream.Write(bytes, 0, bytes.Length);
                nativeBackupWritten += bytes.Length;
                nativeBackupNextChunk++;
                PostWorkspaceMessage(web, new { type = "native-backup-result", id, seq });
                return true;
            }
            if (type == "native-backup-file-finish")
            {
                if (nativeBackupStream == null || nativeBackupWritten != nativeBackupExpected)
                    throw new InvalidDataException("备份文件不完整。");
                nativeBackupStream.Flush(true);
                nativeBackupStream.Dispose();
                nativeBackupStream = null;
                PostWorkspaceMessage(web, new { type = "native-backup-result", id, path = nativeBackupRelative });
                return true;
            }
            if (type == "native-backup-finish")
            {
                if (nativeBackupStream != null) throw new InvalidOperationException("仍有备份文件未写完。");
                var result = nativeBackupTarget;
                RememberCompletedCloudBackup(result);
                nativeBackupTarget = null;
                nativeBackupChosenRoot = null;
                PostWorkspaceMessage(web, new { type = "native-backup-result", id, path = result });
                return true;
            }
        }
        catch (Exception error)
        {
            StopNativeBackup(true);
            PostWorkspaceMessage(web, new
            {
                type = "native-backup-result",
                id,
                error = error is InvalidOperationException || error is InvalidDataException || error is IOException
                    ? error.Message : "大文件备份失败，请重试。"
            });
        }
        return true;
    }

    private static long AvailableBytes(string path)
    {
        try
        {
            var directory = Directory.Exists(path) ? path : Path.GetDirectoryName(path);
            var root = Path.GetPathRoot(Path.GetFullPath(directory));
            return new DriveInfo(root).AvailableFreeSpace;
        }
        catch { return -1; }
    }

    private static string SizeText(long bytes)
    {
        if (bytes < 0) return "未知";
        if (bytes >= 1024L * 1024 * 1024) return Math.Round(bytes / 1024d / 1024 / 1024, 1) + " GB";
        return Math.Round(bytes / 1024d / 1024, 1) + " MB";
    }

    private void StopNativeBackup(bool removePartial)
    {
        try
        {
            if (nativeBackupStream != null) nativeBackupStream.Dispose();
        }
        catch (IOException) { }
        finally { nativeBackupStream = null; }
        if (removePartial && !String.IsNullOrEmpty(nativeBackupTarget) &&
            !String.IsNullOrEmpty(nativeBackupChosenRoot))
        {
            try
            {
                var target = Path.GetFullPath(nativeBackupTarget);
                if (target.StartsWith(nativeBackupChosenRoot + "\\", StringComparison.OrdinalIgnoreCase) &&
                    Path.GetFileName(target).StartsWith("AnalogNotes-", StringComparison.Ordinal) &&
                    Directory.Exists(target))
                    Directory.Delete(target, true);
            }
            catch { }
        }
        nativeBackupTarget = null;
        nativeBackupChosenRoot = null;
        nativeBackupRelative = null;
        nativeBackupExpected = nativeBackupWritten = 0;
        nativeBackupNextChunk = 0;
    }
}
