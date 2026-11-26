/*
 * [INPUT]: 读取更新 ZIP、声明的基础版本与发行清单。
 * [OUTPUT]: 校验版本、文件路径和内容。支持安装前验证连续的增量版本。
 * [POS]: 本地更新、在线更新和安装器共用的包校验。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

internal sealed class ReleaseManifest
{
    public string version { get; set; }
    public string baseVersion { get; set; }
    public ReleaseFile[] files { get; set; }
    public bool requiresDataBackup { get; set; }
}
internal sealed class ReleaseFile
{
    public string path { get; set; }
    public long size { get; set; }
    public string sha256 { get; set; }
}
internal static class UpdatePackage
{
    internal static string SafePath(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Contains('\\') || value.Contains(':') || value.StartsWith("/")) throw new InvalidDataException("更新包包含无效路径。");
        var parts = value.Split('/');
        if (parts.Any(p => p == "" || p == "." || p == ".." || p.EndsWith(" ") || p.EndsWith(".") || p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || IsReservedName(p))) throw new InvalidDataException("更新包包含无效路径。");
        if (parts[0].Equals("Data", StringComparison.OrdinalIgnoreCase) || parts[0].Equals("UpdateBackups", StringComparison.OrdinalIgnoreCase) || value.Equals("data-location.txt", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("更新包不能包含用户资料。");
        if (parts[0].Equals("models", StringComparison.OrdinalIgnoreCase) &&
            !value.Equals("models/asr/.keep", StringComparison.OrdinalIgnoreCase) &&
            !value.Equals("models/translation/.keep", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("应用更新包不能安装或覆盖模型文件。");
        return Path.Combine(parts);
    }
    private static bool IsReservedName(string part)
    {
        var name = part.Split('.')[0].ToUpperInvariant();
        return name == "CON" || name == "PRN" || name == "AUX" || name == "NUL" ||
            (name.Length == 4 && (name.StartsWith("COM") || name.StartsWith("LPT")) && name[3] >= '1' && name[3] <= '9');
    }

    internal static string CheckVersion(ReleaseManifest incoming, string installDirectory)
    {
        return CheckVersionFrom(incoming, InstalledVersion(installDirectory));
    }

    internal static string InstalledVersion(string installDirectory)
    {
        var path = Path.Combine(installDirectory, "release-manifest.json");
        var currentManifest = File.Exists(path)
            ? new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 }
                .Deserialize<ReleaseManifest>(File.ReadAllText(path))
            : null;
        return currentManifest == null ? "26.1105.0001" : currentManifest.version;
    }

    internal static string CheckVersionFrom(ReleaseManifest incoming, string current)
    {
        if (Version.Parse(incoming.version) <= Version.Parse(current))
            throw new InvalidDataException("请选择比当前版本更新的安装包。当前：" + current);
        if (!String.IsNullOrWhiteSpace(incoming.baseVersion) &&
            !Version.Parse(incoming.baseVersion).Equals(Version.Parse(current)))
            throw new InvalidDataException("这个增量补丁要求从版本 " + incoming.baseVersion + " 升级。当前是 "
                + current + "，请下载完整安装包。");
        return current;
    }

    internal static ReleaseManifest Read(string zipPath, bool verifyFiles)
    {
        using (var zip = ZipFile.OpenRead(zipPath))
        {
            var manifest = Read(zip);
            if (verifyFiles)
            {
                var buffer = new byte[64 * 1024];
                foreach (var file in manifest.files)
                    CopyVerifiedFile(zip, file, Stream.Null, buffer);
            }
            return manifest;
        }
    }

    internal static ReleaseManifest Read(ZipArchive zip)
    {
        var manifestEntry = zip.GetEntry("release-manifest.json");
        if (manifestEntry == null || manifestEntry.Length > 32L * 1024 * 1024) throw new InvalidDataException("不是受支持的 DoNote 更新包。");
        ReleaseManifest manifest;
        using (var reader = new StreamReader(manifestEntry.Open()))
            manifest = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 }.Deserialize<ReleaseManifest>(reader.ReadToEnd());
        Version version;
        if (manifest == null || !Version.TryParse(manifest.version, out version) || manifest.files == null || manifest.files.Length == 0) throw new InvalidDataException("更新包版本信息无效。");
        Version baseVersion;
        if (!String.IsNullOrWhiteSpace(manifest.baseVersion) &&
            (!Version.TryParse(manifest.baseVersion, out baseVersion) || baseVersion >= version))
            throw new InvalidDataException("更新包基础版本信息无效。");
        var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in manifest.files)
        {
            if (file == null || String.Equals(file.path, "release-manifest.json", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("更新包文件清单无效。");
            SafePath(file.path);
            if (!known.Add(file.path) || file.size < 0 || file.sha256 == null || file.sha256.Length != 64 || !file.sha256.All(Uri.IsHexDigit)) throw new InvalidDataException("更新包文件清单无效。");
            var entry = zip.GetEntry(file.path);
            if (entry == null || entry.Length != file.size) throw new InvalidDataException("更新包文件缺失或大小不符：" + file.path);
        }
        if (!known.Contains("DoNote.exe")) throw new InvalidDataException("更新包缺少主程序。");
        var entryNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in zip.Entries)
            if (!entry.FullName.EndsWith("/"))
            {
                if (!entryNames.Add(entry.FullName)) throw new InvalidDataException("更新包包含重复文件。");
                if (entry.FullName != "release-manifest.json" && !known.Contains(entry.FullName)) throw new InvalidDataException("更新包包含未列出的文件。");
            }
        return manifest;
    }

    internal static void CopyVerifiedFile(ZipArchive zip, ReleaseFile file, Stream output, byte[] buffer)
    {
        using (var sha = SHA256.Create())
        using (var input = zip.GetEntry(file.path).Open())
        {
            long length = 0;
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) != 0)
            {
                length += read;
                if (length > file.size) throw new InvalidDataException("更新包文件大小不符：" + file.path);
                sha.TransformBlock(buffer, 0, read, buffer, 0);
                output.Write(buffer, 0, read);
            }
            sha.TransformFinalBlock(buffer, 0, 0);
            var hash = BitConverter.ToString(sha.Hash).Replace("-", "");
            if (length != file.size || !hash.Equals(file.sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("更新包校验失败：" + file.path);
        }
    }
}
