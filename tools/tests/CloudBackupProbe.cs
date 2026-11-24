/*
 * [INPUT]: 读取回归程序提供的目标、快照名称和临时目录。
 * [OUTPUT]: 调用桌面真实传输代码。列出快照或输出恢复目录。
 * [POS]: 提供没有 WebView2 界面的云备份测试入口。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Threading;

internal static class CloudBackupProbe
{
    internal static int Main(string[] args)
    {
        try
        {
            var webdav = args[0] == "webdav";
            var operation = args[1];
            using (var transport = new CloudBackupTransport(
                webdav ? null : args[2], webdav ? args[2] : null,
                webdav ? "qa-user" : null, webdav ? args[3] : null))
            {
                var cancellation = operation == "cancel-upload"
                    ? new CancellationToken(true) : CancellationToken.None;
                if (operation == "list")
                {
                    foreach (var name in transport.ListAsync(cancellation).GetAwaiter().GetResult())
                        Console.WriteLine(name);
                }
                else if (operation == "upload" || operation == "cancel-upload")
                {
                    transport.UploadAsync(args[4], args[5], null, cancellation).GetAwaiter().GetResult();
                }
                else if (operation == "download")
                {
                    Console.WriteLine(transport.DownloadAsync(args[4], args[5], null, cancellation).GetAwaiter().GetResult());
                }
                else
                {
                    throw new ArgumentException("未知测试步骤。");
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }
}
