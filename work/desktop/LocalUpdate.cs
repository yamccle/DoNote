using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed partial class WorkspaceWindow
{
    private bool updateChecking;

    private async void BeginLocalUpdate()
    {
        if (updateChecking) return;
        updateChecking = true;
        try
        {
            string package;
            using (var picker = new OpenFileDialog { Title = "选择 DoNote 更新包", Filter = "DoNote 更新包 (*.zip)|*.zip", CheckFileExists = true })
            {
                if (picker.ShowDialog(this) != DialogResult.OK) return;
                package = picker.FileName;
            }
            var installDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            var preflight = await Task.Run(() =>
            {
                var manifest = UpdatePackage.Read(package, false);
                return Tuple.Create(manifest, UpdatePackage.CheckVersion(manifest, installDirectory));
            });
            if (IsDisposed || Disposing) return;
            var incoming = preflight.Item1;
            var current = preflight.Item2;
            var patch = !String.IsNullOrWhiteSpace(incoming.baseVersion);
            var helper = Path.Combine(installDirectory, "DoNoteUpdater.exe");
            if (!File.Exists(helper)) throw new FileNotFoundException("当前版本没有更新助手，请先覆盖安装支持更新的版本。");
            string message = "当前版本：" + current + "\n目标版本：" + incoming.version
                + "\n更新方式：" + (patch ? "增量补丁（仅变化文件）" : "完整包")
                + "\n\n更新助手将先备份被替换的程序文件，安装失败会自动恢复。请先保存正在编辑的内容。现在开始吗？";
            if (MessageBox.Show(this, message, "安装 DoNote 更新", MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.OK) return;
            var temporary = Path.Combine(Path.GetTempPath(), "DoNote-Update-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temporary);
            var copiedHelper = Path.Combine(temporary, "DoNoteUpdater.exe");
            File.Copy(helper, copiedHelper);
            Process.Start(new ProcessStartInfo(copiedHelper)
            {
                Arguments = Quote(package) + " " + Quote(installDirectory) + " " + Quote(dataRoot) + " " + Process.GetCurrentProcess().Id,
                UseShellExecute = false,
                WorkingDirectory = temporary
            });
            CloseWithoutExitPrompt();
        }
        catch (Exception error)
        {
            if (!IsDisposed && !Disposing)
                MessageBox.Show(this, error.Message, "无法安装更新", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally { updateChecking = false; }
    }
    private static string Quote(string path) { return "\"" + path.Replace("\"", "") + "\""; }
}
