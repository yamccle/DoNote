/*
 * [INPUT]: 读取独立测试目录。
 * [OUTPUT]: 验证连续选包、缺包回退、安装中断和资料保护。
 * [POS]: 调用正式规划器和更新器。只操作合成安装目录。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

internal static class UpdateChainProbe
{
    private static void Main(string[] args)
    {
        TestPlanner();
        TestInstaller(args[0]);
    }

    private static void TestPlanner()
    {
        var start = new Version("26.1100.0001");
        var end = new Version("26.1103.0004");
        var step1 = Asset("DoNote-Update-26.1100.0001-to-r101.zip", 10);
        var step2 = Asset("DoNote-Update-26.1101.0002-to-r102.zip", 20);
        var step3 = Asset("DoNote-Update-26.1102.0003-to-r103.zip", 30);
        var full = Asset("DoNote-Windows-x64-r102.zip", 42);
        var fullLatest = Asset("DoNote-Windows-x64-r103.zip", 100);
        var preview = Asset("DoNote-Update-26.1100.0001-to-r104.zip", 1);
        var releases = new[]
        {
            Release("r103", "26.1103.0004", step3, fullLatest),
            Release("r101", "26.1101.0002", step1),
            Release("r102", "26.1102.0003", step2, full),
            Release("r104", "26.1102.0003", preview)
        };
        releases[3].prerelease = true;
        AssertPath(OnlineUpdatePlan.Find(start, end, releases, _ => true), step1, step2, step3);
        AssertPath(OnlineUpdatePlan.Find(start, end, releases, asset => asset != step2), full, step3);
        AssertPath(OnlineUpdatePlan.Find(start, end, releases, asset => asset != step3), fullLatest);
        Require(OnlineUpdatePlan.Find(start, end, releases, asset => asset != step3 && asset != fullLatest) == null,
            "缺少到达最新版本的路径时应停止");
        Console.WriteLine("PASS 更新规划：三段增量、完整包桥接、直达完整包与缺包拦截。");
    }

    private static void TestInstaller(string root)
    {
        var install = Path.Combine(root, "app");
        var data = Path.Combine(install, "Data");
        var models = Path.Combine(install, "models");
        var plan = Path.Combine(root, "chain.json");
        Directory.CreateDirectory(data);
        Directory.CreateDirectory(models);
        var exe = Path.Combine(install, "DoNote.exe");
        var locked = Path.Combine(install, "lock.txt");
        File.WriteAllText(exe, "v1");
        File.WriteAllText(locked, "original");
        File.WriteAllText(Path.Combine(data, "note.txt"), "资料");
        File.WriteAllText(Path.Combine(models, "model.bin"), "模型");
        File.WriteAllText(Path.Combine(install, "release-manifest.json"), "{\"version\":\"26.1100.0001\"}");
        WritePackage(Path.Combine(root, "001.zip"), "26.1101.0002", "26.1100.0001", "v2", null);
        WritePackage(Path.Combine(root, "002.zip"), "26.1103.0004", "26.1102.0003", "v3", "changed");
        File.WriteAllText(plan, "[\"001.zip\",\"002.zip\"]");

        try { UpdateHost.InstallChain(plan, install, data); throw new Exception("接受了断开的增量链"); }
        catch (InvalidDataException) { }
        Require(File.ReadAllText(exe) == "v1", "预检失败不应安装首个包");
        File.Delete(Path.Combine(root, "002.zip"));
        WritePackage(Path.Combine(root, "002.zip"), "26.1103.0004", "26.1101.0002", "v3", "changed");
        using (File.Open(locked, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            try { UpdateHost.InstallChain(plan, install, data); throw new Exception("占用的文件应导致更新失败"); }
            catch (IOException error) { Require(error.Message.Contains("26.1101.0002"), "应报告最后成功的版本"); }
        }
        Require(UpdatePackage.InstalledVersion(install) == "26.1101.0002" && File.ReadAllText(exe) == "v2", "第二步失败后应回到第一步");
        Require(File.ReadAllText(locked) == "original", "第二步失败后文件应回退");

        File.Delete(Path.Combine(root, "001.zip"));
        File.Move(Path.Combine(root, "002.zip"), Path.Combine(root, "001.zip"));
        File.WriteAllText(plan, "[\"001.zip\"]");
        UpdateHost.InstallChain(plan, install, data);
        Require(UpdatePackage.InstalledVersion(install) == "26.1103.0004" && File.ReadAllText(exe) == "v3", "应从最后成功的版本继续更新");
        Require(File.ReadAllText(Path.Combine(data, "note.txt")) == "资料" &&
            File.ReadAllText(Path.Combine(models, "model.bin")) == "模型", "资料和模型应保留");
        Console.WriteLine("PASS 连续安装：错误基础版本预检、第二步失败回退、从已完成版本继续与资料保护。");
    }

    private static GitHubUpdateAsset Asset(string name, long size)
    {
        return new GitHubUpdateAsset { name = name, size = size };
    }

    private static GitHubUpdateRelease Release(string tag, string version, params GitHubUpdateAsset[] assets)
    {
        return new GitHubUpdateRelease { tag_name = tag, name = tag + " · " + version, assets = assets };
    }

    private static void AssertPath(List<OnlineUpdateStep> path, params GitHubUpdateAsset[] expected)
    {
        Require(path != null && path.Select(step => step.Asset).SequenceEqual(expected), "选包路径与预期不符");
    }

    private static void WritePackage(string path, string version, string fromVersion, string exe, string locked)
    {
        var files = new List<ReleaseFile>();
        using (var zip = ZipFile.Open(path, ZipArchiveMode.Create))
        {
            files.Add(Write(zip, "DoNote.exe", exe));
            if (locked != null) files.Add(Write(zip, "lock.txt", locked));
            var manifest = new ReleaseManifest { version = version, baseVersion = fromVersion, files = files.ToArray() };
            Write(zip, "release-manifest.json", new JavaScriptSerializer().Serialize(manifest));
        }
    }

    private static ReleaseFile Write(ZipArchive zip, string name, string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        using (var stream = zip.CreateEntry(name).Open()) stream.Write(bytes, 0, bytes.Length);
        using (var hash = SHA256.Create())
            return new ReleaseFile { path = name, size = bytes.Length, sha256 = BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "") };
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
