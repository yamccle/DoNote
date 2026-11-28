/*
 * [INPUT]: 读取附带 DNSETUP1 尾部的自解压安装器或已安装目录的 release-manifest.json。
 * [OUTPUT]: 校验内嵌 ZIP 与 SHA-256、流式解压安装、写出纯卸载器、创建快捷方式、注册 HKCU 卸载项并执行默认保留用户资料的安全卸载。
 * [POS]: 用户级安装向导与卸载器的核心引擎，与 UpdatePackage 共享清单与路径安全边界。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

internal sealed class SetupTrailer
{
    internal const int ByteSize = 56;
    internal const string Magic = "DNSETUP1";
    internal long PayloadOffset;
    internal long PayloadLength;
    internal byte[] PayloadSha256;
}

internal sealed class SetupOptions
{
    internal string InstallDirectory;
    internal bool CreateDesktopShortcut = true;
    internal bool CreateStartMenuShortcut = true;
    internal bool LaunchAfterInstall = true;
    internal bool RemoveData;
    internal bool Silent;
    internal string ShortcutDirectory;
    internal string RegistryKeyName = "DoNote";
}

internal sealed class SetupInstallResult
{
    internal string Version;
    internal string PreviousVersion;
    internal bool WasUpgrade;
    internal int ExtractedFiles;
    internal long ExtractedBytes;
    internal string UninstallerPath;
}

internal sealed class SetupUninstallResult
{
    internal int RemovedFiles;
    internal bool DataPreserved;
    internal bool ScheduledSelfDelete;
}

internal sealed class SubStream : Stream
{
    private readonly Stream _inner;
    private readonly long _offset;
    private readonly long _length;
    private long _position;

    internal SubStream(Stream inner, long offset, long length)
    {
        _inner = inner;
        _offset = offset;
        _length = length;
        _inner.Seek(_offset, SeekOrigin.Begin);
    }

    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return _length; } }

    public override long Position
    {
        get { return _position; }
        set { Seek(value, SeekOrigin.Begin); }
    }

    public override void Flush() { }

    public override int Read(byte[] buffer, int offset, int count)
    {
        var remaining = _length - _position;
        if (remaining <= 0) return 0;
        if (count > remaining) count = (int)remaining;
        if (_inner.Position != _offset + _position) _inner.Seek(_offset + _position, SeekOrigin.Begin);
        var read = _inner.Read(buffer, offset, count);
        _position += read;
        return read;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        long target;
        if (origin == SeekOrigin.Begin) target = offset;
        else if (origin == SeekOrigin.Current) target = _position + offset;
        else target = _length + offset;
        if (target < 0 || target > _length) throw new ArgumentOutOfRangeException("offset");
        _position = target;
        _inner.Seek(_offset + _position, SeekOrigin.Begin);
        return _position;
    }

    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}

internal static class SetupPackage
{
    private const string UninstallRegistryBase = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    private const string SingleInstanceMutexName = "Local\\YamsOne.Desktop";

    internal static string DefaultInstallDirectory()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(localAppData, "Programs", "DoNote");
    }

    internal static bool TryReadTrailer(string exePath, out SetupTrailer trailer)
    {
        trailer = null;
        if (string.IsNullOrWhiteSpace(exePath) || !File.Exists(exePath)) return false;
        using (var stream = File.OpenRead(exePath))
        {
            if (stream.Length < SetupTrailer.ByteSize) return false;
            stream.Seek(-SetupTrailer.ByteSize, SeekOrigin.End);
            var raw = new byte[SetupTrailer.ByteSize];
            if (ReadExact(stream, raw, 0, raw.Length) != raw.Length) return false;
            var magic = Encoding.ASCII.GetString(raw, 48, 8);
            if (!string.Equals(magic, SetupTrailer.Magic, StringComparison.Ordinal)) return false;
            var offset = BitConverter.ToInt64(raw, 0);
            var length = BitConverter.ToInt64(raw, 8);
            if (offset <= 0 || length <= 0 || offset + length + SetupTrailer.ByteSize != stream.Length) return false;
            var hash = new byte[32];
            Buffer.BlockCopy(raw, 16, hash, 0, 32);
            trailer = new SetupTrailer { PayloadOffset = offset, PayloadLength = length, PayloadSha256 = hash };
            return true;
        }
    }

    internal static ReleaseManifest InspectEmbeddedManifest(string exePath)
    {
        SetupTrailer trailer;
        if (!TryReadTrailer(exePath, out trailer))
            throw new InvalidDataException("当前程序未包含有效的 DoNote 安装载荷。");
        using (var stream = File.OpenRead(exePath))
        using (var sub = new SubStream(stream, trailer.PayloadOffset, trailer.PayloadLength))
        using (var zip = new ZipArchive(sub, ZipArchiveMode.Read, true))
            return UpdatePackage.Read(zip);
    }

    internal static ReleaseManifest VerifyPayload(string exePath, Action<int, string> report)
    {
        SetupTrailer trailer;
        if (!TryReadTrailer(exePath, out trailer))
            throw new InvalidDataException("安装包尾部校验签名缺失或已损坏。");
        Report(report, 2, "正在校验安装包完整性…");
        using (var stream = File.OpenRead(exePath))
        {
            VerifyPayloadHash(stream, trailer, report, 2, 16);
            using (var sub = new SubStream(stream, trailer.PayloadOffset, trailer.PayloadLength))
            using (var zip = new ZipArchive(sub, ZipArchiveMode.Read, true))
            {
                Report(report, 18, "正在校验发行清单…");
                return UpdatePackage.Read(zip);
            }
        }
    }

    internal static string TryReadInstalledVersion(string installDirectory)
    {
        if (string.IsNullOrWhiteSpace(installDirectory)) return null;
        var manifestPath = Path.Combine(installDirectory, "release-manifest.json");
        if (!File.Exists(manifestPath)) return null;
        try
        {
            var manifest = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 }
                .Deserialize<ReleaseManifest>(File.ReadAllText(manifestPath));
            return manifest != null ? manifest.version : null;
        }
        catch
        {
            return null;
        }
    }

    internal static SetupInstallResult Install(string exePath, SetupOptions options, Action<int, string> report)
    {
        if (options == null || string.IsNullOrWhiteSpace(options.InstallDirectory))
            throw new ArgumentException("请指定有效的安装目录。");
        var installDir = Path.GetFullPath(options.InstallDirectory.Trim());
        ValidateInstallDirectory(installDir);

        SetupTrailer trailer;
        if (!TryReadTrailer(exePath, out trailer))
            throw new InvalidDataException("安装包尾部校验签名缺失或已损坏。");

        bool acquired;
        using (var mutex = new Mutex(true, SingleInstanceMutexName, out acquired))
        {
            if (!acquired)
                throw new IOException("检测到 DoNote 正在运行或正在执行更新。请先关闭 DoNote 后再安装。");

            var previousVersion = TryReadInstalledVersion(installDir);
            var previousManifest = TryReadManifestObject(Path.Combine(installDir, "release-manifest.json"));
            var wasUpgrade = !string.IsNullOrEmpty(previousVersion) || File.Exists(Path.Combine(installDir, "DoNote.exe"));

            Directory.CreateDirectory(installDir);
            long totalBytes = 0;
            int extractedCount = 0;
            ReleaseManifest manifest;

            using (var exeStream = File.OpenRead(exePath))
            {
                Report(report, 2, "正在校验安装包 SHA-256…");
                VerifyPayloadHash(exeStream, trailer, report, 2, 16);

                using (var sub = new SubStream(exeStream, trailer.PayloadOffset, trailer.PayloadLength))
                using (var zip = new ZipArchive(sub, ZipArchiveMode.Read, true))
                {
                    Report(report, 18, "正在读取发行清单…");
                    manifest = UpdatePackage.Read(zip);
                    var totalFiles = manifest.files.Length;
                    var buffer = new byte[128 * 1024];

                    for (var i = 0; i < totalFiles; i++)
                    {
                        var file = manifest.files[i];
                        var relPath = UpdatePackage.SafePath(file.path);
                        var targetPath = Path.Combine(installDir, relPath);
                        if (ShouldPreserveExistingUserFile(file.path, targetPath))
                        {
                            extractedCount++;
                            continue;
                        }
                        var parent = Path.GetDirectoryName(targetPath);
                        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                        var tempPath = targetPath + ".setup-tmp";
                        try
                        {
                            using (var output = File.Create(tempPath))
                                UpdatePackage.CopyVerifiedFile(zip, file, output, buffer);
                            ReplaceFileAtomically(tempPath, targetPath);
                        }
                        finally
                        {
                            TryDeleteFile(tempPath);
                        }
                        totalBytes += file.size;
                        extractedCount++;
                        if (i % 8 == 0 || i == totalFiles - 1)
                        {
                            var percent = 18 + (int)((long)(i + 1) * 72 / totalFiles);
                            Report(report, percent, string.Format("正在解压文件 ({0}/{1})：{2}", i + 1, totalFiles, file.path));
                        }
                    }

                    Report(report, 91, "正在写入发行清单…");
                    var manifestEntry = zip.GetEntry("release-manifest.json");
                    var manifestTarget = Path.Combine(installDir, "release-manifest.json");
                    var manifestTemp = manifestTarget + ".setup-tmp";
                    using (var input = manifestEntry.Open())
                    using (var output = File.Create(manifestTemp))
                        input.CopyTo(output);
                    ReplaceFileAtomically(manifestTemp, manifestTarget);
                }

                if (previousManifest != null && previousManifest.files != null)
                {
                    Report(report, 92, "正在清理旧版冗余程序文件…");
                    RemoveObsoleteProgramFiles(installDir, previousManifest, manifest);
                }

                Report(report, 94, "正在生成卸载程序…");
                var uninstallerPath = Path.Combine(installDir, "DoNoteUninstall.exe");
                WriteStubOnlyExecutable(exeStream, trailer.PayloadOffset, uninstallerPath);

                Report(report, 96, "正在创建快捷方式…");
                CreateConfiguredShortcuts(installDir, options);

                Report(report, 98, "正在注册 Windows 卸载信息…");
                RegisterUninstallEntry(installDir, manifest.version, uninstallerPath, totalBytes, options.RegistryKeyName);

                Report(report, 100, "安装完成。");
                return new SetupInstallResult
                {
                    Version = manifest.version,
                    PreviousVersion = previousVersion,
                    WasUpgrade = wasUpgrade,
                    ExtractedFiles = extractedCount,
                    ExtractedBytes = totalBytes,
                    UninstallerPath = uninstallerPath
                };
            }
        }
    }

    internal static SetupUninstallResult Uninstall(string currentExePath, SetupOptions options, Action<int, string> report)
    {
        if (options == null || string.IsNullOrWhiteSpace(options.InstallDirectory))
            throw new ArgumentException("未指定卸载目录。");
        var installDir = Path.GetFullPath(options.InstallDirectory.Trim());
        ValidateInstallDirectory(installDir);

        bool acquired;
        using (var mutex = new Mutex(true, SingleInstanceMutexName, out acquired))
        {
            if (!acquired)
                throw new IOException("检测到 DoNote 正在运行。请先关闭 DoNote 后再卸载。");

            var removedFiles = 0;
            var manifestPath = Path.Combine(installDir, "release-manifest.json");
            var manifest = TryReadManifestObject(manifestPath);

            Report(report, 10, "正在移除程序文件…");
            if (manifest != null && manifest.files != null)
            {
                var total = manifest.files.Length;
                for (var i = 0; i < total; i++)
                {
                    var entry = manifest.files[i];
                    if (entry == null || string.IsNullOrWhiteSpace(entry.path)) continue;
                    if (!options.RemoveData && IsProtectedUserPath(entry.path)) continue;
                    string relPath;
                    try { relPath = UpdatePackage.SafePath(entry.path); }
                    catch { continue; }
                    var fullPath = Path.Combine(installDir, relPath);
                    if (TryDeleteFile(fullPath)) removedFiles++;
                    if (i % 16 == 0 || i == total - 1)
                    {
                        var percent = 10 + (int)((long)(i + 1) * 65 / Math.Max(1, total));
                        Report(report, percent, string.Format("正在移除程序文件 ({0}/{1})…", i + 1, total));
                    }
                }
            }
            else
            {
                var fallbackExe = Path.Combine(installDir, "DoNote.exe");
                if (TryDeleteFile(fallbackExe)) removedFiles++;
                var fallbackUpdater = Path.Combine(installDir, "DoNoteUpdater.exe");
                if (TryDeleteFile(fallbackUpdater)) removedFiles++;
            }

            if (TryDeleteFile(manifestPath)) removedFiles++;

            if (options.RemoveData)
            {
                Report(report, 80, "正在移除本机资料库与本地模型…");
                TryDeleteDirectory(Path.Combine(installDir, "Data"));
                TryDeleteDirectory(Path.Combine(installDir, "models"));
                TryDeleteDirectory(Path.Combine(installDir, "UpdateBackups"));
                TryDeleteFile(Path.Combine(installDir, "data-location.txt"));
                TryDeleteFile(Path.Combine(installDir, "FolderSync.txt"));
            }

            Report(report, 86, "正在清理空程序目录…");
            RemoveEmptySubdirectories(installDir, options.RemoveData);

            Report(report, 92, "正在移除快捷方式与卸载注册项…");
            RemoveConfiguredShortcuts(options);
            UnregisterUninstallEntry(options.RegistryKeyName);

            var uninstallerPath = Path.Combine(installDir, "DoNoteUninstall.exe");
            var runningFromTarget = !string.IsNullOrWhiteSpace(currentExePath) &&
                string.Equals(Path.GetFullPath(currentExePath), Path.GetFullPath(uninstallerPath), StringComparison.OrdinalIgnoreCase);

            var scheduledSelfDelete = false;
            if (runningFromTarget)
            {
                ScheduleSelfDelete(uninstallerPath, installDir);
                scheduledSelfDelete = true;
            }
            else
            {
                if (TryDeleteFile(uninstallerPath)) removedFiles++;
                TryDeleteEmptyDirectory(installDir);
            }

            Report(report, 100, options.RemoveData ? "已完全卸载 DoNote 及本机资料。" : "已卸载 DoNote 程序，本机资料与模型已完整保留。");
            return new SetupUninstallResult
            {
                RemovedFiles = removedFiles,
                DataPreserved = !options.RemoveData,
                ScheduledSelfDelete = scheduledSelfDelete
            };
        }
    }

    private static void VerifyPayloadHash(Stream stream, SetupTrailer trailer, Action<int, string> report, int startPercent, int endPercent)
    {
        stream.Seek(trailer.PayloadOffset, SeekOrigin.Begin);
        var buffer = new byte[256 * 1024];
        long remaining = trailer.PayloadLength;
        long processed = 0;
        var lastPercent = startPercent;
        using (var sha = SHA256.Create())
        {
            while (remaining > 0)
            {
                var toRead = remaining > buffer.Length ? buffer.Length : (int)remaining;
                var read = stream.Read(buffer, 0, toRead);
                if (read <= 0) throw new InvalidDataException("安装包载荷意外截断。");
                sha.TransformBlock(buffer, 0, read, buffer, 0);
                remaining -= read;
                processed += read;
                var percent = startPercent + (int)(processed * (endPercent - startPercent) / trailer.PayloadLength);
                if (percent > lastPercent)
                {
                    lastPercent = percent;
                    Report(report, percent, "正在校验安装包完整性…");
                }
            }
            sha.TransformFinalBlock(buffer, 0, 0);
            if (!BytesEqual(sha.Hash, trailer.PayloadSha256))
                throw new InvalidDataException("安装包 SHA-256 校验失败，文件可能下载不完整或已损坏。");
        }
    }

    private static void WriteStubOnlyExecutable(Stream exeStream, long stubLength, string destinationPath)
    {
        var tempPath = destinationPath + ".setup-tmp";
        try
        {
            exeStream.Seek(0, SeekOrigin.Begin);
            var buffer = new byte[64 * 1024];
            long remaining = stubLength;
            using (var output = File.Create(tempPath))
            {
                while (remaining > 0)
                {
                    var toRead = remaining > buffer.Length ? buffer.Length : (int)remaining;
                    var read = exeStream.Read(buffer, 0, toRead);
                    if (read <= 0) throw new IOException("无法写出卸载程序。");
                    output.Write(buffer, 0, read);
                    remaining -= read;
                }
            }
            ReplaceFileAtomically(tempPath, destinationPath);
        }
        finally
        {
            TryDeleteFile(tempPath);
        }
    }

    private static void CreateConfiguredShortcuts(string installDir, SetupOptions options)
    {
        var targetExe = Path.Combine(installDir, "DoNote.exe");
        if (!string.IsNullOrWhiteSpace(options.ShortcutDirectory))
        {
            if (options.CreateDesktopShortcut || options.CreateStartMenuShortcut)
            {
                Directory.CreateDirectory(options.ShortcutDirectory);
                CreateShortcut(Path.Combine(options.ShortcutDirectory, "DoNote.lnk"), targetExe, installDir, "DoNote 跨学科科研与个人知识工作台");
            }
            return;
        }
        if (options.CreateDesktopShortcut)
        {
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            if (!string.IsNullOrWhiteSpace(desktop))
                CreateShortcut(Path.Combine(desktop, "DoNote.lnk"), targetExe, installDir, "DoNote 跨学科科研与个人知识工作台");
        }
        if (options.CreateStartMenuShortcut)
        {
            var programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            if (!string.IsNullOrWhiteSpace(programs))
            {
                var folder = Path.Combine(programs, "DoNote");
                Directory.CreateDirectory(folder);
                CreateShortcut(Path.Combine(folder, "DoNote.lnk"), targetExe, installDir, "DoNote 跨学科科研与个人知识工作台");
                CreateShortcut(Path.Combine(folder, "卸载 DoNote.lnk"), Path.Combine(installDir, "DoNoteUninstall.exe"), installDir, "卸载 DoNote", "--uninstall --dir=\"" + installDir + "\"");
            }
        }
    }

    private static void RemoveConfiguredShortcuts(SetupOptions options)
    {
        if (!string.IsNullOrWhiteSpace(options.ShortcutDirectory))
        {
            TryDeleteFile(Path.Combine(options.ShortcutDirectory, "DoNote.lnk"));
            return;
        }
        var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (!string.IsNullOrWhiteSpace(desktop))
            TryDeleteFile(Path.Combine(desktop, "DoNote.lnk"));
        var programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        if (!string.IsNullOrWhiteSpace(programs))
            TryDeleteDirectory(Path.Combine(programs, "DoNote"));
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory, string description, string arguments = "")
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) return;
        object shell = Activator.CreateInstance(shellType);
        object shortcut = null;
        try
        {
            shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
            var scType = shortcut.GetType();
            scType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath });
            scType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDirectory });
            scType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { description });
            scType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath + ",0" });
            if (!string.IsNullOrEmpty(arguments))
                scType.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { arguments });
            scType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
        finally
        {
            if (shortcut != null) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut);
            if (shell != null) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
        }
    }

    private static void RegisterUninstallEntry(string installDir, string version, string uninstallerPath, long extractedBytes, string keyName)
    {
        var subKeyName = string.IsNullOrWhiteSpace(keyName) ? "DoNote" : keyName.Trim();
        using (var key = Registry.CurrentUser.CreateSubKey(UninstallRegistryBase + "\\" + subKeyName))
        {
            if (key == null) return;
            var quotedUninstaller = "\"" + uninstallerPath + "\"";
            var quotedDir = "\"" + installDir + "\"";
            key.SetValue("DisplayName", "DoNote", RegistryValueKind.String);
            key.SetValue("DisplayVersion", version ?? "", RegistryValueKind.String);
            key.SetValue("Publisher", "DoNote", RegistryValueKind.String);
            key.SetValue("InstallLocation", installDir, RegistryValueKind.String);
            key.SetValue("DisplayIcon", Path.Combine(installDir, "DoNote.exe") + ",0", RegistryValueKind.String);
            key.SetValue("UninstallString", quotedUninstaller + " --uninstall --dir=" + quotedDir, RegistryValueKind.String);
            key.SetValue("QuietUninstallString", quotedUninstaller + " --uninstall --silent --dir=" + quotedDir, RegistryValueKind.String);
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            key.SetValue("EstimatedSize", (int)Math.Max(1, extractedBytes / 1024), RegistryValueKind.DWord);
            key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"), RegistryValueKind.String);
        }
    }

    private static void UnregisterUninstallEntry(string keyName)
    {
        var subKeyName = string.IsNullOrWhiteSpace(keyName) ? "DoNote" : keyName.Trim();
        try
        {
            Registry.CurrentUser.DeleteSubKeyTree(UninstallRegistryBase + "\\" + subKeyName, false);
        }
        catch { }
    }

    private static void RemoveObsoleteProgramFiles(string installDir, ReleaseManifest oldManifest, ReleaseManifest newManifest)
    {
        var keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in newManifest.files) keep.Add(file.path);
        foreach (var oldFile in oldManifest.files)
        {
            if (oldFile == null || string.IsNullOrWhiteSpace(oldFile.path)) continue;
            if (keep.Contains(oldFile.path) || IsProtectedUserPath(oldFile.path)) continue;
            try
            {
                var rel = UpdatePackage.SafePath(oldFile.path);
                TryDeleteFile(Path.Combine(installDir, rel));
            }
            catch { }
        }
    }

    private static bool ShouldPreserveExistingUserFile(string manifestPath, string targetPath)
    {
        if (!File.Exists(targetPath)) return false;
        return IsProtectedUserPath(manifestPath);
    }

    private static bool IsProtectedUserPath(string manifestPath)
    {
        if (string.IsNullOrWhiteSpace(manifestPath)) return false;
        var norm = manifestPath.Replace('\\', '/').TrimStart('/');
        return norm.Equals("Data", StringComparison.OrdinalIgnoreCase)
            || norm.StartsWith("Data/", StringComparison.OrdinalIgnoreCase)
            || norm.Equals("data-location.txt", StringComparison.OrdinalIgnoreCase)
            || norm.Equals("FolderSync.txt", StringComparison.OrdinalIgnoreCase)
            || norm.Equals("UpdateBackups", StringComparison.OrdinalIgnoreCase)
            || norm.StartsWith("UpdateBackups/", StringComparison.OrdinalIgnoreCase)
            || norm.Equals("models", StringComparison.OrdinalIgnoreCase)
            || norm.StartsWith("models/", StringComparison.OrdinalIgnoreCase);
    }

    private static void ValidateInstallDirectory(string fullPath)
    {
        var root = Path.GetPathRoot(fullPath);
        if (string.IsNullOrEmpty(root) || string.Equals(fullPath.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("不能直接选择磁盘根目录作为安装目录，请选择子文件夹（例如 DoNote）。");
    }

    private static ReleaseManifest TryReadManifestObject(string path)
    {
        if (!File.Exists(path)) return null;
        try
        {
            return new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 }
                .Deserialize<ReleaseManifest>(File.ReadAllText(path));
        }
        catch
        {
            return null;
        }
    }

    private static void ReplaceFileAtomically(string tempPath, string targetPath)
    {
        if (File.Exists(targetPath))
        {
            File.SetAttributes(targetPath, FileAttributes.Normal);
            File.Delete(targetPath);
        }
        File.Move(tempPath, targetPath);
    }

    private static void RemoveEmptySubdirectories(string rootDir, bool includeUserDirs)
    {
        if (!Directory.Exists(rootDir)) return;
        foreach (var dir in Directory.GetDirectories(rootDir))
        {
            var name = Path.GetFileName(dir);
            if (!includeUserDirs && (name.Equals("Data", StringComparison.OrdinalIgnoreCase)
                || name.Equals("models", StringComparison.OrdinalIgnoreCase)
                || name.Equals("UpdateBackups", StringComparison.OrdinalIgnoreCase)))
                continue;
            RemoveEmptySubdirectories(dir, includeUserDirs);
            TryDeleteEmptyDirectory(dir);
        }
    }

    private static void ScheduleSelfDelete(string uninstallerPath, string installDir)
    {
        try
        {
            var cmd = "/C ping 127.0.0.1 -n 2 > nul & del /f /q \"" + uninstallerPath + "\" & rmdir \"" + installDir + "\" 2>nul";
            Process.Start(new ProcessStartInfo("cmd.exe", cmd)
            {
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                UseShellExecute = false
            });
        }
        catch { }
    }

    private static bool TryDeleteFile(string path)
    {
        try
        {
            if (!File.Exists(path)) return false;
            File.SetAttributes(path, FileAttributes.Normal);
            File.Delete(path);
            return true;
        }
        catch { return false; }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, true);
        }
        catch { }
    }

    private static void TryDeleteEmptyDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path) && !Directory.EnumerateFileSystemEntries(path).Any())
                Directory.Delete(path, false);
        }
        catch { }
    }

    private static int ReadExact(Stream stream, byte[] buffer, int offset, int count)
    {
        var total = 0;
        while (total < count)
        {
            var read = stream.Read(buffer, offset + total, count - total);
            if (read == 0) break;
            total += read;
        }
        return total;
    }

    private static bool BytesEqual(byte[] a, byte[] b)
    {
        if (a == null || b == null || a.Length != b.Length) return false;
        var diff = 0;
        for (var i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
        return diff == 0;
    }

    private static void Report(Action<int, string> report, int percent, string status)
    {
        if (report != null) report(Math.Max(0, Math.Min(100, percent)), status);
    }
}
