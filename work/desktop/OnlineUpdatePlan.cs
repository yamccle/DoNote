/*
 * [INPUT]: 读取 GitHub 正式发行版、资产和当前安装版本。
 * [OUTPUT]: 计算到目标版本的连续更新路径及总下载量。
 * [POS]: 在线更新选包逻辑。只比较版本与大小。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

internal sealed class GitHubUpdateRelease
{
    public string tag_name { get; set; }
    public string name { get; set; }
    public string body { get; set; }
    public bool draft { get; set; }
    public bool prerelease { get; set; }
    public GitHubUpdateAsset[] assets { get; set; }

    internal string VersionText()
    {
        return Regex.Match((name ?? "") + "\n" + (body ?? ""), @"\b\d+\.\d+\.\d+\b").Value;
    }

    internal Version ReadVersion()
    {
        Version version;
        return !draft && !prerelease && Version.TryParse(VersionText(), out version) ? version : null;
    }
}

internal sealed class GitHubUpdateAsset
{
    public string name { get; set; }
    public string browser_download_url { get; set; }
    public long size { get; set; }
    public string digest { get; set; }
}

internal sealed class OnlineUpdateStep
{
    internal Version BaseVersion;
    internal Version Version;
    internal GitHubUpdateRelease Release;
    internal GitHubUpdateAsset Asset;
    internal string Sha256 { get; set; }
}

internal static class OnlineUpdatePlan
{
    internal static List<OnlineUpdateStep> Find(Version current, Version target, IEnumerable<GitHubUpdateRelease> releases,
        Func<GitHubUpdateAsset, bool> eligible)
    {
        var states = new Dictionary<Version, List<OnlineUpdateStep>> { { current, new List<OnlineUpdateStep>() } };
        var destinations = releases.Select(release => new { Release = release, Version = release.ReadVersion() })
            .Where(item => item.Version != null && item.Version > current && item.Version <= target)
            .OrderBy(item => item.Version);
        foreach (var item in destinations)
        {
            var release = item.Release;
            if (!Regex.IsMatch(release.tag_name ?? "", @"\Ar[0-9]+\z")) continue;
            foreach (var asset in release.assets ?? new GitHubUpdateAsset[0])
            {
                if (asset == null || asset.size <= 0 || !eligible(asset)) continue;
                var name = asset.name ?? "";
                var full = String.Equals(name, "DoNote-Windows-x64-" + release.tag_name + ".zip", StringComparison.OrdinalIgnoreCase);
                var patch = Regex.Match(name, @"\ADoNote-Update-(\d+\.\d+\.\d+)-to-" + release.tag_name + @"\.zip\z", RegexOptions.IgnoreCase);
                Version previous = null;
                List<OnlineUpdateStep> path;
                if (full) path = states[current];
                else if (!patch.Success || !Version.TryParse(patch.Groups[1].Value, out previous) ||
                    previous >= item.Version || !states.TryGetValue(previous, out path)) continue;

                var candidate = new List<OnlineUpdateStep>(path) {
                    new OnlineUpdateStep { BaseVersion = previous, Version = item.Version, Release = release, Asset = asset }
                };
                List<OnlineUpdateStep> existing;
                if (!states.TryGetValue(item.Version, out existing) || IsBetter(candidate, existing))
                    states[item.Version] = candidate;
            }
        }
        List<OnlineUpdateStep> result;
        return states.TryGetValue(target, out result) ? result : null;
    }

    private static bool IsBetter(List<OnlineUpdateStep> candidate, List<OnlineUpdateStep> existing)
    {
        long candidateSize = candidate.Sum(step => step.Asset.size);
        long existingSize = existing.Sum(step => step.Asset.size);
        return candidateSize < existingSize || (candidateSize == existingSize && candidate.Count < existing.Count);
    }
}
