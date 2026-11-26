/*
 * [INPUT]: 读取本地更新 ZIP 或经桌面宿主校验的更新顺序。
 * [OUTPUT]: 逐包安装、回退失败步骤，并在整次更新结束后启动 DoNote。
 * [POS]: 独立更新进程。持有单实例锁，保护每一步的程序和资料边界。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class UpdateHost
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        var chain = args.Length == 5 && args[4] == "--chain";
        int parentId;
        if ((!chain && args.Length != 4) || !int.TryParse(args[3], out parentId)) return;
        var window = new Form
        {
            Text = "DoNote · 正在更新", Width = 450, Height = 145, StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedDialog, ControlBox = false,
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath)
        };
        var label = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Text = "正在等待 DoNote 退出…" };
        var canClose = false;
        window.FormClosing += (sender, eventArgs) =>
        {
            if (eventArgs.CloseReason == CloseReason.UserClosing && !canClose) eventArgs.Cancel = true;
        };
        window.Controls.Add(label);
        window.Shown += async (sender, eventArgs) =>
        {
            string backup = null;
            try
            {
                IProgress<string> progress = new Progress<string>(status => label.Text = status);
                backup = await Task.Run(() =>
                {
                    try { using (var parent = Process.GetProcessById(parentId)) if (!parent.WaitForExit(60000)) throw new IOException("DoNote 未能在 60 秒内退出。"); }
                    catch (ArgumentException) { }
                    bool reserved;
                    // Share DoNote's single-instance mutex to prevent a restart during installation.
                    using (var instance = new Mutex(true, "Local\\YamsOne.Desktop", out reserved))
                    {
                        if (!reserved) throw new IOException("DoNote 已重新打开，或正在进行另一次更新。");
                        return chain ? InstallChain(args[0], args[1], args[2], progress.Report)
                            : Install(args[0], args[1], args[2], report: progress.Report);
                    }
                });
                var message = Directory.Exists(Path.Combine(backup, "Data"))
                    ? "更新完成。旧版程序和资料备份位于：\n" + backup
                    : "更新完成。旧版程序备份位于：\n" + backup + "\n资料目录保持原位。";
                if (chain)
                {
                    label.Text = "更新完成，正在重新启动 DoNote…";
                    await Task.Delay(800);
                }
                else MessageBox.Show(window, message, "DoNote 已更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception error)
            {
                MessageBox.Show(window, "更新未完成。请查看下方恢复结果。\n\n" + error.Message + (backup == null ? "" : "\n备份：" + backup), "DoNote 更新失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                if (chain) RemoveOnlineUpdateFiles(args[0]);
                try { Process.Start(new ProcessStartInfo(Path.Combine(args[1], "DoNote.exe")) { WorkingDirectory = args[1], UseShellExecute = true }); }
                catch (Exception error) { MessageBox.Show(window, "请手动打开 DoNote.exe。\n" + error.Message); }
                canClose = true;
                window.Close();
            }
        };
        Application.Run(window);
    }

    internal static string InstallChain(string plan, string installDirectory, string dataDirectory, Action<string> report = null)
    {
        var packages = ReadChainPackages(plan);
        string installed = UpdatePackage.InstalledVersion(installDirectory);
        string current = installed;
        var versions = new string[packages.Length];
        for (var index = 0; index < packages.Length; index++)
        {
            var manifest = UpdatePackage.Read(packages[index], false);
            UpdatePackage.CheckVersionFrom(manifest, current);
            versions[index] = current = manifest.version;
        }

        string backup = null;
        for (var index = 0; index < packages.Length; index++)
        {
            var label = "步骤 " + (index + 1) + " / " + packages.Length + " · " + versions[index] + "\n";
            try
            {
                backup = Install(packages[index], installDirectory, dataDirectory, report: status => Report(report, label + status));
                installed = versions[index];
            }
            catch (Exception error)
            {
                throw new IOException(label + error.Message + "\n最后成功安装的版本：" + installed, error);
            }
        }
        return backup;
    }

    private static string[] ReadChainPackages(string plan)
    {
        if (!File.Exists(plan) || new FileInfo(plan).Length > 65536) throw new InvalidDataException("更新计划不存在或太大。");
        var root = Path.GetDirectoryName(Path.GetFullPath(plan));
        var names = new JavaScriptSerializer().Deserialize<string[]>(File.ReadAllText(plan));
        if (names == null || names.Length == 0 || names.Where((name, index) => name != (index + 1).ToString("D3") + ".zip").Any())
            throw new InvalidDataException("更新计划中的文件顺序无效。");
        return names.Select(name => Path.Combine(root, name)).ToArray();
    }

    private static void RemoveOnlineUpdateFiles(string plan)
    {
        try
        {
            var root = AppDomain.CurrentDomain.BaseDirectory;
            if (!String.Equals(Path.GetFullPath(plan), Path.Combine(root, "chain.json"), StringComparison.OrdinalIgnoreCase)) return;
            foreach (var package in ReadChainPackages(plan)) File.Delete(package);
            File.Delete(plan);
        }
        catch { }
    }

    internal static string Install(string package, string installDirectory, string dataDirectory, int failAfter = -1, Action<string> report = null)
    {
        installDirectory = Path.GetFullPath(installDirectory);
        dataDirectory = Path.GetFullPath(dataDirectory);
        var backupRoot = Path.Combine(Path.GetDirectoryName(installDirectory), "DoNote-Backups");
        var backup = Path.Combine(backupRoot, "update-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 6));
        if (Inside(dataDirectory, backup)) throw new IOException("备份目录不能位于资料目录内。");
        var extracted = Path.Combine(installDirectory, ".update-" + Guid.NewGuid().ToString("N"));
        if (Inside(dataDirectory, extracted)) throw new IOException("更新临时目录不能位于资料目录内。");
        var changed = new List<string>();
        var applied = new List<Tuple<string, bool>>();
        var checkedDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var oldManifest = Path.Combine(installDirectory, "release-manifest.json");
        EnsureNoReparsePoint(oldManifest);
        Directory.CreateDirectory(extracted);
        try
        {
            bool requiresDataBackup;
            Report(report, "正在读取更新包…");
            using (var zip = ZipFile.OpenRead(package))
            {
                var manifest = UpdatePackage.Read(zip);
                UpdatePackage.CheckVersion(manifest, installDirectory);
                requiresDataBackup = manifest.requiresDataBackup;
                var buffer = new byte[64 * 1024];
                var elapsed = Stopwatch.StartNew();
                int checkedFiles = 0;
                Report(report, "正在比较本机文件并校验需要安装的文件…");
                foreach (var file in manifest.files)
                {
                    checkedFiles++;
                    if (elapsed.ElapsedMilliseconds >= 500)
                    {
                        Report(report, "正在比较和校验文件… " + checkedFiles + " / " + manifest.files.Length);
                        elapsed.Restart();
                    }
                    var relative = UpdatePackage.SafePath(file.path);
                    var target = Path.Combine(installDirectory, relative);
                    if (Inside(dataDirectory, target) || String.Equals(dataDirectory, target, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("更新包不能覆盖资料目录：" + file.path);
                    var parent = Path.GetDirectoryName(target);
                    while (Inside(installDirectory, parent) && checkedDirectories.Add(parent))
                    {
                        EnsureNoReparsePoint(parent);
                        parent = Path.GetDirectoryName(parent);
                    }
                    EnsureNoReparsePoint(target);
                    // Check local content before opening the ZIP entry. Installed runtimes can be in use.
                    if (File.Exists(target) && MatchesReleaseFile(target, file)) continue;
                    var staged = Path.Combine(extracted, relative);
                    Directory.CreateDirectory(Path.GetDirectoryName(staged));
                    using (var output = File.Create(staged))
                        UpdatePackage.CopyVerifiedFile(zip, file, output, buffer);
                    changed.Add(relative);
                }
                zip.GetEntry("release-manifest.json").ExtractToFile(Path.Combine(extracted, "release-manifest.json"));
            }
            Report(report, "正在备份需要替换的文件…");
            Directory.CreateDirectory(backup);
            if (requiresDataBackup && Directory.Exists(dataDirectory))
                CopyDirectory(dataDirectory, Path.Combine(backup, "Data"));
            foreach (var relative in changed)
            {
                var target = Path.Combine(installDirectory, relative);
                if (File.Exists(target))
                {
                    var saved = Path.Combine(backup, "Program", relative);
                    Directory.CreateDirectory(Path.GetDirectoryName(saved));
                    File.Copy(target, saved);
                }
            }
            if (File.Exists(oldManifest))
            {
                Directory.CreateDirectory(Path.Combine(backup, "Program"));
                File.Copy(oldManifest, Path.Combine(backup, "Program", "release-manifest.json"));
            }
            try
            {
                Report(report, "正在安装已校验的文件…");
                foreach (var relative in changed)
                {
                    var target = Path.Combine(installDirectory, relative);
                    bool existed = File.Exists(target);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    applied.Add(Tuple.Create(relative, existed));
                    InstallFile(Path.Combine(extracted, relative), target, existed);
                    if (applied.Count == failAfter) throw new IOException("模拟安装中断");
                }
                InstallFile(Path.Combine(extracted, "release-manifest.json"), oldManifest, File.Exists(oldManifest));
            }
            catch (Exception installError)
            {
                Report(report, "正在恢复旧版程序…");
                var rollbackErrors = new List<string>();
                foreach (var item in Enumerable.Reverse(applied))
                    try
                    {
                        var target = Path.Combine(installDirectory, item.Item1);
                        if (item.Item2)
                        {
                            var saved = Path.Combine(backup, "Program", item.Item1);
                            if (!FilesEqual(target, saved)) File.Copy(saved, target, true);
                        }
                        else if (File.Exists(target)) File.Delete(target);
                    }
                    catch (Exception error) { rollbackErrors.Add(item.Item1 + ": " + error.Message); }
                try
                {
                    var saved = Path.Combine(backup, "Program", "release-manifest.json");
                    if (File.Exists(saved)) File.Copy(saved, oldManifest, true);
                    else if (File.Exists(oldManifest)) File.Delete(oldManifest);
                }
                catch (Exception error) { rollbackErrors.Add("版本清单：" + error.Message); }
                throw new IOException("安装失败：" + installError.Message + (rollbackErrors.Count == 0 ? "；原程序已恢复。" : "；部分回退失败，请使用备份恢复：" + string.Join("；", rollbackErrors)) + "\n备份位置：" + backup, installError);
            }
            return backup;
        }
        finally { try { if (Inside(installDirectory, extracted) && Directory.Exists(extracted)) Directory.Delete(extracted, true); } catch { } }
    }

    private static void Report(Action<string> report, string message)
    {
        if (report != null) report(message);
    }

    private static void InstallFile(string staged, string target, bool existed)
    {
        if (existed) File.Replace(staged, target, null, true);
        else File.Move(staged, target);
    }

    private static void EnsureNoReparsePoint(string path)
    {
        try
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("更新路径不能是符号链接：" + path);
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
    }

    private static bool MatchesReleaseFile(string path, ReleaseFile file)
    {
        try { return new FileInfo(path).Length == file.size && HashFile(path).Equals(file.sha256, StringComparison.OrdinalIgnoreCase); }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private static bool FilesEqual(string first, string second)
    {
        try { return File.Exists(first) && File.Exists(second) && new FileInfo(first).Length == new FileInfo(second).Length && HashFile(first) == HashFile(second); }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private static string HashFile(string path)
    {
        using (var input = File.OpenRead(path))
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "");
    }

    private static bool Inside(string parent, string path)
    {
        parent = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return Path.GetFullPath(path).StartsWith(parent, StringComparison.OrdinalIgnoreCase);
    }
    private static void CopyDirectory(string source, string destination)
    {
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new IOException("资料目录不能是符号链接。");
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.GetFiles(source))
        {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("资料中包含符号链接，无法完整备份。");
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        }
        foreach (var folder in Directory.GetDirectories(source)) CopyDirectory(folder, Path.Combine(destination, Path.GetFileName(folder)));
    }
}
