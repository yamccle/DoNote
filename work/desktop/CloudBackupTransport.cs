/*
 * [INPUT]: 接收完成的 DoNote 备份目录、同步目录或 WebDAV 连接。
 * [OUTPUT]: 流式传输已校验的 ZIP 快照，并按完成标记列出版本。
 * [POS]: 位于 WebView2 宿主和远端存储之间。恢复过程先写隔离目录。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Xml;

internal sealed class CloudBackupProgress
{
    internal readonly string Message;
    internal readonly long Done, Total;

    internal CloudBackupProgress(string message, long done, long total)
    {
        Message = message;
        Done = done;
        Total = total;
    }
}

internal sealed class CloudBackupMarker
{
    public int version { get; set; }
    public long size { get; set; }
    public long unpackedSize { get; set; }
    public string sha256 { get; set; }
}

internal sealed class CloudBackupTransport : IDisposable
{
    private const int BufferSize = 1024 * 1024;
    private const long MaxBackupManifest = 128L * 1024 * 1024;
    private const int MaxMarkerBytes = 16384;
    private const string ZipSuffix = ".zip";
    private const string MarkerSuffix = ".complete.json";
    private static readonly Regex SnapshotName = new Regex(@"\ADoNote-\d{8}T\d{6}Z-[a-f0-9]{8,32}\z", RegexOptions.CultureInvariant);
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private readonly string folder;
    private readonly Uri endpoint;
    private readonly HttpClient http;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = MaxMarkerBytes };

    internal CloudBackupTransport(string folder, string url, string username, string password)
    {
        if (!String.IsNullOrWhiteSpace(folder))
        {
            if (!String.IsNullOrWhiteSpace(url)) throw new InvalidDataException("请选择一个备份目的地。");
            this.folder = Path.GetFullPath(folder);
            return;
        }
        endpoint = ValidateEndpoint(url, username, password);
        http = new HttpClient(new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            UseDefaultCredentials = false,
            UseProxy = !IsLoopback(endpoint)
        });
        http.Timeout = TimeSpan.FromHours(6);
        if (!String.IsNullOrEmpty(username) || !String.IsNullOrEmpty(password))
        {
            var auth = Convert.ToBase64String(Encoding.UTF8.GetBytes((username ?? "") + ":" + (password ?? "")));
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", auth);
        }
    }

    internal static Uri ValidateEndpoint(string url, string username, string password)
    {
        Uri address;
        if (String.IsNullOrWhiteSpace(url) || url.Length > 2048 || url.IndexOf('\\') >= 0 ||
            !Uri.TryCreate(url.Trim(), UriKind.Absolute, out address) ||
            (address.Scheme != "https" && !(address.Scheme == "http" && IsLoopback(address))) ||
            address.UserInfo.Length != 0 || address.Query.Length != 0 || address.Fragment.Length != 0)
            throw new InvalidDataException("请输入 HTTPS WebDAV 文件夹地址。本机回环连接可使用 HTTP。");
        if ((username != null && (username.Length > 512 || username.IndexOf(':') >= 0 || username.Any(Char.IsControl))) ||
            (password != null && (password.Length > 2048 || password.Any(Char.IsControl))))
            throw new InvalidDataException("WebDAV 用户名或密码格式无效。");
        return new Uri(address.GetLeftPart(UriPartial.Path).TrimEnd('/') + "/");
    }

    private static bool IsLoopback(Uri address)
    {
        IPAddress ip;
        return String.Equals(address.Host, "localhost", StringComparison.OrdinalIgnoreCase) ||
            (IPAddress.TryParse(address.Host.Trim('[', ']'), out ip) && IPAddress.IsLoopback(ip));
    }

    internal static bool ValidName(string name)
    {
        if (name == null || !SnapshotName.IsMatch(name)) return false;
        DateTime date;
        return DateTime.TryParseExact(name.Substring(7, 16), "yyyyMMdd'T'HHmmss'Z'",
            CultureInfo.InvariantCulture, DateTimeStyles.None, out date);
    }

    internal async Task<string[]> ListAsync(CancellationToken cancellation)
    {
        var names = folder == null ? await ListWebDavAsync(cancellation) : ListFolder(cancellation);
        return names.Where(name => name.EndsWith(MarkerSuffix, StringComparison.Ordinal))
            .Select(name => name.Substring(0, name.Length - MarkerSuffix.Length))
            .Where(name => ValidName(name) && names.Contains(name + ZipSuffix))
            .OrderByDescending(name => name, StringComparer.Ordinal).ToArray();
    }

    private HashSet<string> ListFolder(CancellationToken cancellation)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var path in Directory.EnumerateFiles(folder))
        {
            cancellation.ThrowIfCancellationRequested();
            names.Add(Path.GetFileName(path));
        }
        return names;
    }

    private async Task<HashSet<string>> ListWebDavAsync(CancellationToken cancellation)
    {
        using (var request = new HttpRequestMessage(new HttpMethod("PROPFIND"), endpoint))
        {
            request.Headers.TryAddWithoutValidation("Depth", "1");
            request.Content = new StringContent(
                "<propfind xmlns=\"DAV:\"><prop><resourcetype/></prop></propfind>", Encoding.UTF8, "application/xml");
            using (var response = await SendAsync(request, cancellation))
            using (cancellation.Register(response.Dispose))
            using (var source = await response.Content.ReadAsStreamAsync())
            using (var reader = XmlReader.Create(source, new XmlReaderSettings
            {
                Async = true,
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null,
                MaxCharactersInDocument = 16 * 1024 * 1024
            }))
            {
                var names = new HashSet<string>(StringComparer.Ordinal);
                while (await reader.ReadAsync())
                {
                    cancellation.ThrowIfCancellationRequested();
                    if (reader.NodeType != XmlNodeType.Element || reader.LocalName != "href" || reader.NamespaceURI != "DAV:") continue;
                    if (reader.IsEmptyElement || !await reader.ReadAsync() || reader.NodeType != XmlNodeType.Text) continue;
                    Uri target;
                    if (!Uri.TryCreate(endpoint, reader.Value.Trim(), out target) ||
                        target.Scheme != endpoint.Scheme || target.IdnHost != endpoint.IdnHost ||
                        target.Port != endpoint.Port || target.UserInfo.Length != 0 || target.Query.Length != 0 ||
                        target.Fragment.Length != 0)
                        continue;
                    var basePath = Uri.UnescapeDataString(endpoint.AbsolutePath);
                    var targetPath = Uri.UnescapeDataString(target.AbsolutePath);
                    if (!targetPath.StartsWith(basePath, StringComparison.Ordinal))
                        continue;
                    var name = targetPath.Substring(basePath.Length);
                    if (!String.IsNullOrEmpty(name) && name.IndexOfAny(new[] { '/', '\\' }) < 0)
                        names.Add(name);
                }
                return names;
            }
        }
    }

    internal async Task UploadAsync(string name, string sourceDirectory, IProgress<CloudBackupProgress> progress, CancellationToken cancellation)
    {
        RequireName(name);
        var source = Path.GetFullPath(sourceDirectory);
        var parent = Path.GetDirectoryName(source);
        var space = Path.Combine(parent, ".DoNote-transfer-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(space);
        try
        {
            var marker = new CloudBackupMarker { version = 1 };
            var entries = EnumerateSource(source).ToList();
            marker.unpackedSize = entries.Sum(item => item.Length);
            var manifest = entries.SingleOrDefault(item => item.Name == "backup.json" && item.DirectoryName == source);
            if (manifest == null || manifest.Length <= 0 || manifest.Length > MaxBackupManifest)
                throw new InvalidDataException("缺少完整的备份清单。");
            CheckFreeSpace(space, marker.unpackedSize);
            var archive = Path.Combine(space, name + ZipSuffix);
            using (var output = CreateFile(archive))
            using (var zip = new ZipArchive(output, ZipArchiveMode.Create, false, Utf8))
            {
                long written = 0;
                foreach (var entry in entries)
                {
                    cancellation.ThrowIfCancellationRequested();
                    var relative = entry.FullName.Substring(WithSeparator(source).Length).Replace('\\', '/');
                    ResolveEntry(source, relative);
                    using (var input = OpenFile(entry.FullName))
                    using (var target = zip.CreateEntry(relative, CompressionLevel.NoCompression).Open())
                        await CopyAsync(input, target, entry.Length, progress, "正在打包工作台", written, marker.unpackedSize, cancellation);
                    written += entry.Length;
                }
            }
            marker.size = new FileInfo(archive).Length;
            marker.sha256 = await HashFileAsync(archive, marker.size, progress, "正在计算备份校验值", cancellation);
            if (folder != null)
                await UploadFolderAsync(name, archive, marker, progress, cancellation);
            else
            {
                using (var content = new CloudFileContent(archive, marker.size, progress, cancellation))
                    await PutAsync(name + ZipSuffix, content, cancellation);
                await VerifyRemoteSizeAsync(name + ZipSuffix, marker.size, cancellation);
                using (var content = new StringContent(json.Serialize(marker), Utf8, "application/json"))
                    await PutAsync(name + MarkerSuffix, content, cancellation);
            }
        }
        finally { RemoveTransferDirectory(parent, space); }
    }

    private async Task UploadFolderAsync(string name, string archive, CloudBackupMarker marker, IProgress<CloudBackupProgress> progress, CancellationToken cancellation)
    {
        CheckFreeSpace(folder, marker.size);
        var pending = Path.Combine(folder, ".DoNote-" + Guid.NewGuid().ToString("N") + ".partial");
        var pendingMarker = pending + ".json";
        var target = Path.Combine(folder, name + ZipSuffix);
        var targetMarker = Path.Combine(folder, name + MarkerSuffix);
        try
        {
            if (File.Exists(target) || File.Exists(targetMarker)) throw new IOException("目标备份已存在，请重新备份。");
            using (var input = OpenFile(archive))
            using (var output = CreateFile(pending))
            {
                await CopyAsync(input, output, marker.size, progress, "正在写入同步目录", 0, marker.size, cancellation);
                output.Flush(true);
            }
            var digest = await HashFileAsync(pending, marker.size, progress, "正在校验同步目录备份", cancellation);
            if (digest != marker.sha256) throw new InvalidDataException("备份校验失败，未写入完成标记。");
            cancellation.ThrowIfCancellationRequested();
            using (var stream = CreateFile(pendingMarker))
            {
                var markerBytes = Utf8.GetBytes(json.Serialize(marker));
                stream.Write(markerBytes, 0, markerBytes.Length);
                stream.Flush(true);
            }
            File.Move(pending, target);
            File.Move(pendingMarker, targetMarker);
        }
        finally
        {
            TryDeleteFile(pending);
            TryDeleteFile(pendingMarker);
        }
    }

    internal async Task<string> DownloadAsync(string name, string destinationRoot, IProgress<CloudBackupProgress> progress, CancellationToken cancellation)
    {
        RequireName(name);
        var destination = Path.GetFullPath(destinationRoot);
        var final = Path.Combine(destination, name);
        if (Directory.Exists(final) || File.Exists(final)) throw new IOException("目标中已有这个版本，请另选文件夹。");
        var marker = await ReadMarkerAsync(name, cancellation);
        CheckFreeSpace(destination, checked(marker.size + marker.unpackedSize));
        var stage = Path.Combine(destination, ".DoNote-transfer-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        try
        {
            var archive = Path.Combine(stage, "backup.zip");
            using (var output = CreateFile(archive))
            {
                if (folder != null)
                {
                    using (var input = OpenFile(Path.Combine(folder, name + ZipSuffix)))
                        await CopyAsync(input, output, marker.size, progress, "正在读取同步目录备份", 0, marker.size, cancellation);
                }
                else
                {
                    using (var response = await GetAsync(name + ZipSuffix, cancellation))
                    using (cancellation.Register(response.Dispose))
                    using (var input = await response.Content.ReadAsStreamAsync())
                        await CopyAsync(input, output, marker.size, progress, "正在下载备份", 0, marker.size, cancellation);
                }
            }
            var digest = await HashFileAsync(archive, marker.size, progress, "正在校验备份", cancellation);
            if (digest != marker.sha256) throw new InvalidDataException("备份校验失败。同步未完成或文件已损坏。");
            var unpacked = Path.Combine(stage, "snapshot");
            Directory.CreateDirectory(unpacked);
            await ExtractAsync(archive, unpacked, marker.unpackedSize, progress, cancellation);
            cancellation.ThrowIfCancellationRequested();
            Directory.Move(unpacked, final);
            return final;
        }
        finally { RemoveTransferDirectory(destination, stage); }
    }

    private async Task<CloudBackupMarker> ReadMarkerAsync(string name, CancellationToken cancellation)
    {
        using (var buffer = new MemoryStream())
        {
            if (folder != null)
            {
                using (var input = OpenFile(Path.Combine(folder, name + MarkerSuffix)))
                    await ReadMarkerStreamAsync(input, buffer, cancellation);
            }
            else
            {
                using (var response = await GetAsync(name + MarkerSuffix, cancellation))
                using (cancellation.Register(response.Dispose))
                using (var input = await response.Content.ReadAsStreamAsync())
                    await ReadMarkerStreamAsync(input, buffer, cancellation);
            }
            var marker = json.Deserialize<CloudBackupMarker>(Utf8.GetString(buffer.ToArray()));
            if (marker == null || marker.version != 1 || marker.size <= 0 || marker.unpackedSize <= 0 ||
                marker.size > Int64.MaxValue - marker.unpackedSize || marker.sha256 == null ||
                !Regex.IsMatch(marker.sha256, @"\A[a-f0-9]{64}\z"))
                throw new InvalidDataException("备份完成标记无效。");
            return marker;
        }
    }

    private static async Task ReadMarkerStreamAsync(Stream input, Stream output, CancellationToken cancellation)
    {
        var buffer = new byte[4096];
        for (;;)
        {
            var count = await input.ReadAsync(buffer, 0, buffer.Length, cancellation);
            if (count == 0) break;
            if (output.Length + count > MaxMarkerBytes) throw new InvalidDataException("备份完成标记过大。");
            output.Write(buffer, 0, count);
        }
    }

    private static async Task ExtractAsync(string archive, string unpacked, long expected, IProgress<CloudBackupProgress> progress, CancellationToken cancellation)
    {
        using (var stream = OpenFile(archive))
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Read, false, Utf8))
        {
            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long total = 0;
            var hasManifest = false;
            foreach (var entry in zip.Entries)
            {
                cancellation.ThrowIfCancellationRequested();
                var target = ResolveEntry(unpacked, entry.FullName);
                if (!paths.Add(target) || entry.Length < 0 || entry.Length > expected - total)
                    throw new InvalidDataException("备份清单中有重复路径或大小不一致。");
                if (entry.FullName == "backup.json")
                {
                    if (entry.Length <= 0 || entry.Length > MaxBackupManifest)
                        throw new InvalidDataException("备份清单大小无效。");
                    hasManifest = true;
                }
                total += entry.Length;
            }
            if (!hasManifest || total != expected) throw new InvalidDataException("备份文件不完整。");
            long written = 0;
            foreach (var entry in zip.Entries)
            {
                cancellation.ThrowIfCancellationRequested();
                var target = ResolveEntry(unpacked, entry.FullName);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                using (var input = entry.Open())
                using (var output = CreateFile(target))
                    await CopyAsync(input, output, entry.Length, progress, "正在解包备份", written, total, cancellation);
                written += entry.Length;
            }
        }
    }

    private async Task PutAsync(string name, HttpContent content, CancellationToken cancellation)
    {
        using (var request = new HttpRequestMessage(HttpMethod.Put, new Uri(endpoint, name)))
        {
            request.Headers.TryAddWithoutValidation("If-None-Match", "*");
            request.Content = content;
            using (await SendAsync(request, cancellation)) { }
        }
    }

    private async Task<HttpResponseMessage> GetAsync(string name, CancellationToken cancellation)
    {
        using (var request = new HttpRequestMessage(HttpMethod.Get, new Uri(endpoint, name)))
            return await SendAsync(request, cancellation);
    }

    private async Task VerifyRemoteSizeAsync(string name, long expected, CancellationToken cancellation)
    {
        using (var request = new HttpRequestMessage(HttpMethod.Head, new Uri(endpoint, name)))
        using (var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation))
        {
            if (response.StatusCode == HttpStatusCode.MethodNotAllowed || response.StatusCode == HttpStatusCode.NotImplemented) return;
            EnsureSuccess(response);
            if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != expected)
                throw new InvalidDataException("服务器返回的备份大小不一致，未写入完成标记。");
        }
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
    {
        var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
        try { EnsureSuccess(response); return response; }
        catch { response.Dispose(); throw; }
    }

    private static void EnsureSuccess(HttpResponseMessage response)
    {
        if (response.IsSuccessStatusCode) return;
        var code = (int)response.StatusCode;
        switch (code)
        {
            case 401: case 403: throw new IOException("WebDAV 拒绝访问，请检查账号、密码和文件夹权限。");
            case 404: throw new IOException("WebDAV 文件或目录不可用，请检查地址或等待同步完成。");
            case 409: case 412: throw new IOException("目标备份已存在或无法新建，请重新备份。");
            case 507: throw new IOException("WebDAV 远端空间不足。");
        }
        if (code >= 300 && code < 400) throw new IOException("WebDAV 地址发生重定向，请直接填写最终的文件夹地址。");
        throw new IOException("WebDAV 请求失败（HTTP " + code + "）。");
    }

    private static IEnumerable<FileInfo> EnumerateSource(string path)
    {
        var root = new DirectoryInfo(path);
        if ((root.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("备份目录中包含重解析节点。");
        foreach (var item in root.EnumerateFileSystemInfos())
        {
            if ((item.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("备份目录中包含重解析节点。");
            var file = item as FileInfo;
            if (file != null) yield return file;
            else foreach (var nested in EnumerateSource(item.FullName)) yield return nested;
        }
    }

    private static String ResolveEntry(string root, string name)
    {
        var relative = UpdatePackage.SafePath(name);
        var path = Path.GetFullPath(Path.Combine(root, relative));
        if (!path.StartsWith(WithSeparator(root), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("备份文件路径无效。");
        return path;
    }

    private static FileStream OpenFile(string path)
    {
        return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, BufferSize, FileOptions.Asynchronous | FileOptions.SequentialScan);
    }

    private static FileStream CreateFile(string path)
    {
        return new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, BufferSize, FileOptions.Asynchronous | FileOptions.SequentialScan);
    }

    private static async Task CopyAsync(Stream input, Stream output, long expected, IProgress<CloudBackupProgress> progress,
        string message, long offset, long total, CancellationToken cancellation)
    {
        var buffer = new byte[BufferSize];
        long done = 0;
        var clock = System.Diagnostics.Stopwatch.StartNew();
        while (done < expected)
        {
            var count = await input.ReadAsync(buffer, 0, (int)Math.Min(buffer.Length, expected - done), cancellation);
            if (count == 0) throw new InvalidDataException("备份文件大小不一致或同步未完成。");
            await output.WriteAsync(buffer, 0, count, cancellation);
            done += count;
            if (clock.ElapsedMilliseconds < 150 && offset + done != total) continue;
            if (progress != null) progress.Report(new CloudBackupProgress(message, offset + done, total));
            clock.Restart();
        }
        if (await input.ReadAsync(buffer, 0, 1, cancellation) != 0)
            throw new InvalidDataException("备份文件大小不一致。");
    }

    private static async Task<string> HashAsync(Stream source, long size, IProgress<CloudBackupProgress> progress, string message, CancellationToken cancellation)
    {
        using (var hash = SHA256.Create())
        using (var checksum = new CryptoStream(Stream.Null, hash, CryptoStreamMode.Write))
        {
            await CopyAsync(source, checksum, size, progress, message, 0, size, cancellation);
            checksum.FlushFinalBlock();
            return BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
        }
    }

    private static async Task<string> HashFileAsync(string path, long size, IProgress<CloudBackupProgress> progress, string message, CancellationToken cancellation)
    {
        using (var source = OpenFile(path))
            return await HashAsync(source, size, progress, message, cancellation);
    }

    private static string WithSeparator(string path)
    {
        return path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
    }

    private static void RequireName(string name)
    {
        if (!ValidName(name)) throw new InvalidDataException("备份版本名称无效。");
    }

    private static void CheckFreeSpace(string directory, long bytes)
    {
        long available;
        try { available = new DriveInfo(Path.GetPathRoot(directory)).AvailableFreeSpace; }
        catch { return; }
        if (available < bytes) throw new IOException("本机可用空间不足，无法完成备份传输。");
    }

    private static void TryDeleteFile(string path)
    {
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    internal static void RemoveTransferDirectory(string parent, string directory)
    {
        try
        {
            var path = Path.GetFullPath(directory);
            if (!String.Equals(WithSeparator(Path.GetDirectoryName(path)), WithSeparator(Path.GetFullPath(parent)), StringComparison.OrdinalIgnoreCase) ||
                !Regex.IsMatch(Path.GetFileName(path), @"\A\.DoNote-transfer-[a-f0-9]{32}\z") ||
                !Directory.Exists(path)) return;
            foreach (var unused in EnumerateSource(path)) { }
            Directory.Delete(path, true);
        }
        catch (IOException) { }
        catch (InvalidDataException) { }
        catch (UnauthorizedAccessException) { }
    }

    public void Dispose()
    {
        if (http != null) http.Dispose();
    }

    private sealed class CloudFileContent : HttpContent
    {
        private readonly string path;
        private readonly long size;
        private readonly IProgress<CloudBackupProgress> progress;
        private readonly CancellationToken cancellation;

        internal CloudFileContent(string path, long size, IProgress<CloudBackupProgress> progress, CancellationToken cancellation)
        {
            this.path = path;
            this.size = size;
            this.progress = progress;
            this.cancellation = cancellation;
            Headers.ContentType = new MediaTypeHeaderValue("application/zip");
        }

        protected override bool TryComputeLength(out long length)
        {
            length = size;
            return true;
        }

        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext context)
        {
            using (var source = OpenFile(path))
                await CopyAsync(source, stream, size, progress, "正在上传备份", 0, size, cancellation);
        }
    }
}
