using System;
using System.Collections.Generic;
using System.IO;

internal static class InstallationLayoutMigration
{
    internal static string Migrate(string appRoot)
    {
        var root = Path.GetFullPath(appRoot).TrimEnd('\\');
        var docs = Path.Combine(root, "docs");
        var workers = Path.Combine(root, "video-runtime", "workers");
        var bridgeWorkers = Path.Combine(root, "ai-bridge", "workers");
        var featureAssets = Path.Combine(root, "workspace", "assets");
        // Only move legacy files after the organized layout has landed.
        if (!Directory.Exists(docs) || !Directory.Exists(workers) ||
            !Directory.Exists(bridgeWorkers) || !Directory.Exists(featureAssets))
            return null;
        var freshMarker = Path.Combine(root, "fresh-start.marker");
        if (File.Exists(freshMarker))
        {
            try { File.SetAttributes(freshMarker, File.GetAttributes(freshMarker) | FileAttributes.Hidden); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        var legacyFiles = new[]
        {
            "AI接入指南.md", "开始使用.md", "使用说明.md", "视频模型下载说明.md",
            "视频字幕使用说明.md", "本地离线翻译模型说明.md", "模型目录说明.md",
            "video-transcribe.py", "video-translate.py", "local-llm-translate.py",
            "web-fetch.mjs", "ai-face.gif", "DoNote.ico"
        };
        var existingFiles = new List<string>();
        foreach (var name in legacyFiles)
        {
            var path = Path.Combine(root, name);
            if (File.Exists(path)) existingFiles.Add(path);
        }
        var legacyLicenses = Path.Combine(root, "licenses");
        var hasLicenses = Directory.Exists(legacyLicenses);
        if (existingFiles.Count == 0 && !hasLicenses) return null;

        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var destination = Path.Combine(docs, "legacy-from-update-" + stamp);
        Directory.CreateDirectory(destination);
        foreach (var path in existingFiles)
        {
            var target = UniqueTarget(destination, Path.GetFileName(path));
            File.Move(path, target);
        }
        if (hasLicenses)
        {
            var target = UniqueTarget(destination, "licenses");
            Directory.Move(legacyLicenses, target);
        }
        return destination;
    }

    private static string UniqueTarget(string directory, string name)
    {
        var target = Path.Combine(directory, name);
        if (!File.Exists(target) && !Directory.Exists(target)) return target;
        var suffix = DateTime.Now.Ticks;
        return Path.Combine(directory, Path.GetFileNameWithoutExtension(name)
            + "-" + suffix + Path.GetExtension(name));
    }
}
