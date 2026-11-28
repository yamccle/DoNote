/*
 * [INPUT]: 接收命令行参数（--verify-only / --silent / --uninstall / --dir 等）或用户交互输入。
 * [OUTPUT]: 提供中文用户级安装向导、覆盖升级确认、安全卸载界面以及静默命令行执行入口。
 * [POS]: DoNote-Setup-x64-*.exe 与 DoNoteUninstall.exe 共用的 WinForms 宿主入口。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class SetupHost
{
    private sealed class ParsedArgs
    {
        internal bool VerifyOnly;
        internal bool Uninstall;
        internal string LogPath;
        internal SetupOptions Options = new SetupOptions();
    }

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var parsed = ParseArguments(args);
        var exePath = Application.ExecutablePath;

        if (parsed.VerifyOnly)
        {
            try
            {
                var manifest = SetupPackage.VerifyPayload(exePath, null);
                WriteLog(parsed.LogPath, "OK " + manifest.version + " files=" + manifest.files.Length);
                return 0;
            }
            catch (Exception error)
            {
                WriteLog(parsed.LogPath, "ERROR " + error.Message);
                return 1;
            }
        }

        SetupTrailer trailer;
        var hasPayload = SetupPackage.TryReadTrailer(exePath, out trailer);
        var isUninstallMode = parsed.Uninstall || !hasPayload;

        if (parsed.Options.Silent)
            return RunSilent(exePath, isUninstallMode, parsed);

        if (isUninstallMode)
        {
            var dir = ResolveUninstallDir(exePath, parsed.Options.InstallDirectory);
            parsed.Options.InstallDirectory = dir;
            using (var form = new UninstallWizardForm(exePath, parsed.Options))
                Application.Run(form);
            return 0;
        }

        ReleaseManifest incoming;
        try
        {
            incoming = SetupPackage.InspectEmbeddedManifest(exePath);
        }
        catch (Exception error)
        {
            MessageBox.Show("无法读取安装包内容：\n" + error.Message, "DoNote 安装向导", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        if (string.IsNullOrWhiteSpace(parsed.Options.InstallDirectory))
            parsed.Options.InstallDirectory = SetupPackage.DefaultInstallDirectory();

        using (var form = new InstallWizardForm(exePath, incoming, parsed.Options))
            Application.Run(form);
        return 0;
    }

    private static int RunSilent(string exePath, bool isUninstallMode, ParsedArgs parsed)
    {
        try
        {
            if (isUninstallMode)
            {
                parsed.Options.InstallDirectory = ResolveUninstallDir(exePath, parsed.Options.InstallDirectory);
                var result = SetupPackage.Uninstall(exePath, parsed.Options, null);
                WriteLog(parsed.LogPath, "UNINSTALL_OK removed=" + result.RemovedFiles + " preserved=" + result.DataPreserved);
                return 0;
            }

            if (string.IsNullOrWhiteSpace(parsed.Options.InstallDirectory))
                parsed.Options.InstallDirectory = SetupPackage.DefaultInstallDirectory();
            var install = SetupPackage.Install(exePath, parsed.Options, null);
            WriteLog(parsed.LogPath, "INSTALL_OK version=" + install.Version + " files=" + install.ExtractedFiles + " upgrade=" + install.WasUpgrade);
            return 0;
        }
        catch (Exception error)
        {
            WriteLog(parsed.LogPath, "ERROR " + error.Message);
            return 1;
        }
    }

    private static string ResolveUninstallDir(string exePath, string explicitDir)
    {
        if (!string.IsNullOrWhiteSpace(explicitDir)) return Path.GetFullPath(explicitDir);
        var baseDir = Path.GetDirectoryName(Path.GetFullPath(exePath));
        return string.IsNullOrWhiteSpace(baseDir) ? SetupPackage.DefaultInstallDirectory() : baseDir;
    }

    private static ParsedArgs ParseArguments(string[] args)
    {
        var parsed = new ParsedArgs();
        if (args == null) return parsed;
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i] ?? "";
            if (arg.Equals("--verify-only", StringComparison.OrdinalIgnoreCase)) parsed.VerifyOnly = true;
            else if (arg.Equals("--uninstall", StringComparison.OrdinalIgnoreCase)) parsed.Uninstall = true;
            else if (arg.Equals("--silent", StringComparison.OrdinalIgnoreCase))
            {
                parsed.Options.Silent = true;
                parsed.Options.LaunchAfterInstall = false;
            }
            else if (arg.Equals("--no-shortcuts", StringComparison.OrdinalIgnoreCase))
            {
                parsed.Options.CreateDesktopShortcut = false;
                parsed.Options.CreateStartMenuShortcut = false;
            }
            else if (arg.Equals("--no-launch", StringComparison.OrdinalIgnoreCase)) parsed.Options.LaunchAfterInstall = false;
            else if (arg.Equals("--remove-data", StringComparison.OrdinalIgnoreCase)) parsed.Options.RemoveData = true;
            else if (arg.StartsWith("--dir=", StringComparison.OrdinalIgnoreCase)) parsed.Options.InstallDirectory = TrimQuotes(arg.Substring(6));
            else if (arg.StartsWith("--shortcut-dir=", StringComparison.OrdinalIgnoreCase)) parsed.Options.ShortcutDirectory = TrimQuotes(arg.Substring(15));
            else if (arg.StartsWith("--test-reg-key=", StringComparison.OrdinalIgnoreCase)) parsed.Options.RegistryKeyName = TrimQuotes(arg.Substring(15));
            else if (arg.StartsWith("--log=", StringComparison.OrdinalIgnoreCase)) parsed.LogPath = TrimQuotes(arg.Substring(6));
        }
        return parsed;
    }

    private static string TrimQuotes(string value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        return value.Trim().Trim('"');
    }

    private static void WriteLog(string logPath, string message)
    {
        try { Console.Error.WriteLine(message); } catch { }
        if (string.IsNullOrWhiteSpace(logPath)) return;
        try { File.WriteAllText(logPath, message + Environment.NewLine); } catch { }
    }

    private sealed class InstallWizardForm : Form
    {
        private readonly string _exePath;
        private readonly ReleaseManifest _manifest;
        private readonly SetupOptions _options;
        private readonly TextBox _dirBox;
        private readonly Button _browseButton;
        private readonly Label _modeHintLabel;
        private readonly CheckBox _desktopCheck;
        private readonly CheckBox _startMenuCheck;
        private readonly CheckBox _launchCheck;
        private readonly ProgressBar _progressBar;
        private readonly Label _statusLabel;
        private readonly Button _actionButton;
        private readonly Button _cancelButton;
        private bool _running;
        private bool _finished;

        internal InstallWizardForm(string exePath, ReleaseManifest manifest, SetupOptions options)
        {
            _exePath = exePath;
            _manifest = manifest;
            _options = options;

            Text = "DoNote 安装向导";
            ClientSize = new Size(560, 404);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(248, 250, 252);
            Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular);
            try { Icon = Icon.ExtractAssociatedIcon(exePath); } catch { }

            var header = new Panel { Dock = DockStyle.Top, Height = 82, BackColor = Color.White };
            var title = new Label
            {
                Text = "DoNote 安装向导",
                Font = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(24, 14),
                AutoSize = true
            };
            var subtitle = new Label
            {
                Text = "版本 " + manifest.version + " · 当前用户安装（无需管理员权限）",
                Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(26, 48),
                AutoSize = true
            };
            var divider = new Panel { Dock = DockStyle.Bottom, Height = 1, BackColor = Color.FromArgb(226, 232, 240) };
            header.Controls.Add(title);
            header.Controls.Add(subtitle);
            header.Controls.Add(divider);
            Controls.Add(header);

            var dirLabel = new Label
            {
                Text = "安装目录",
                Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(30, 41, 59),
                Location = new Point(24, 100),
                AutoSize = true
            };
            _dirBox = new TextBox
            {
                Text = options.InstallDirectory,
                Location = new Point(24, 126),
                Width = 414,
                Font = new Font("Microsoft YaHei UI", 9.5f)
            };
            _dirBox.TextChanged += (s, e) => RefreshInstallModeHint();

            _browseButton = new Button
            {
                Text = "浏览…",
                Location = new Point(448, 124),
                Size = new Size(88, 28),
                FlatStyle = FlatStyle.System
            };
            _browseButton.Click += (s, e) => BrowseFolder();

            _modeHintLabel = new Label
            {
                Location = new Point(24, 160),
                Size = new Size(512, 38),
                ForeColor = Color.FromArgb(37, 99, 235),
                Font = new Font("Microsoft YaHei UI", 8.8f)
            };

            _desktopCheck = new CheckBox
            {
                Text = "创建桌面快捷方式",
                Checked = options.CreateDesktopShortcut,
                Location = new Point(24, 206),
                AutoSize = true
            };
            _startMenuCheck = new CheckBox
            {
                Text = "创建「开始」菜单快捷方式",
                Checked = options.CreateStartMenuShortcut,
                Location = new Point(24, 234),
                AutoSize = true
            };
            _launchCheck = new CheckBox
            {
                Text = "安装完成后立即启动 DoNote",
                Checked = options.LaunchAfterInstall,
                Location = new Point(24, 262),
                AutoSize = true
            };

            _progressBar = new ProgressBar
            {
                Location = new Point(24, 298),
                Size = new Size(512, 18),
                Minimum = 0,
                Maximum = 100
            };
            _statusLabel = new Label
            {
                Text = "准备就绪。点击「开始安装」将自动校验并解压程序。",
                Location = new Point(24, 322),
                Size = new Size(512, 22),
                ForeColor = Color.FromArgb(71, 85, 105),
                Font = new Font("Microsoft YaHei UI", 8.8f)
            };

            _actionButton = new Button
            {
                Text = "开始安装",
                Location = new Point(342, 354),
                Size = new Size(102, 34),
                BackColor = Color.FromArgb(37, 99, 235),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _actionButton.FlatAppearance.BorderSize = 0;
            _actionButton.Click += async (s, e) => await StartInstallAsync();

            _cancelButton = new Button
            {
                Text = "取消",
                Location = new Point(454, 354),
                Size = new Size(82, 34),
                FlatStyle = FlatStyle.System
            };
            _cancelButton.Click += (s, e) => Close();

            Controls.AddRange(new Control[]
            {
                dirLabel, _dirBox, _browseButton, _modeHintLabel,
                _desktopCheck, _startMenuCheck, _launchCheck,
                _progressBar, _statusLabel, _actionButton, _cancelButton
            });

            FormClosing += (s, e) =>
            {
                if (_running && e.CloseReason == CloseReason.UserClosing) e.Cancel = true;
            };
            RefreshInstallModeHint();
        }

        private void BrowseFolder()
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择 DoNote 安装目录";
                dialog.SelectedPath = Directory.Exists(_dirBox.Text) ? _dirBox.Text : SetupPackage.DefaultInstallDirectory();
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    var selected = dialog.SelectedPath;
                    if (!selected.EndsWith("DoNote", StringComparison.OrdinalIgnoreCase) &&
                        !File.Exists(Path.Combine(selected, "DoNote.exe")))
                        selected = Path.Combine(selected, "DoNote");
                    _dirBox.Text = selected;
                }
            }
        }

        private void RefreshInstallModeHint()
        {
            var dir = (_dirBox.Text ?? "").Trim();
            var existing = SetupPackage.TryReadInstalledVersion(dir);
            if (!string.IsNullOrEmpty(existing) || (!string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, "DoNote.exe"))))
            {
                _modeHintLabel.ForeColor = Color.FromArgb(21, 128, 61);
                _modeHintLabel.Text = "检测到已有 DoNote" + (string.IsNullOrEmpty(existing) ? "" : "（" + existing + "）")
                    + "：将执行覆盖升级，完整保留 Data 资料库、models 模型与同步配置。";
            }
            else
            {
                _modeHintLabel.ForeColor = Color.FromArgb(71, 85, 105);
                _modeHintLabel.Text = "将执行全新安装，并在「设置 → 应用」中注册当前用户卸载项。";
            }
        }

        private async Task StartInstallAsync()
        {
            if (_finished)
            {
                if (_launchCheck.Checked) TryLaunchDoNote(_options.InstallDirectory);
                Close();
                return;
            }
            if (_running) return;

            _options.InstallDirectory = (_dirBox.Text ?? "").Trim();
            _options.CreateDesktopShortcut = _desktopCheck.Checked;
            _options.CreateStartMenuShortcut = _startMenuCheck.Checked;
            _options.LaunchAfterInstall = _launchCheck.Checked;

            SetInputsEnabled(false);
            _running = true;
            var progress = new Progress<Tuple<int, string>>(p =>
            {
                _progressBar.Value = p.Item1;
                _statusLabel.Text = p.Item2;
            });

            try
            {
                var result = await Task.Run(() => SetupPackage.Install(_exePath, _options, (pct, msg) => ((IProgress<Tuple<int, string>>)progress).Report(Tuple.Create(pct, msg))));
                _finished = true;
                _running = false;
                _progressBar.Value = 100;
                _statusLabel.Text = (result.WasUpgrade ? "覆盖升级完成" : "安装完成") + "（版本 " + result.Version + "）。";
                _actionButton.Text = _launchCheck.Checked ? "完成并启动" : "完成";
                _actionButton.Enabled = true;
                _cancelButton.Visible = false;
            }
            catch (Exception error)
            {
                _running = false;
                SetInputsEnabled(true);
                _statusLabel.Text = "安装未完成：" + error.Message;
                MessageBox.Show(this, "安装未完成：\n\n" + error.Message, "DoNote 安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void SetInputsEnabled(bool enabled)
        {
            _dirBox.Enabled = enabled;
            _browseButton.Enabled = enabled;
            _desktopCheck.Enabled = enabled;
            _startMenuCheck.Enabled = enabled;
            _launchCheck.Enabled = enabled;
            _actionButton.Enabled = enabled;
            _cancelButton.Enabled = enabled;
        }

        private static void TryLaunchDoNote(string installDir)
        {
            try
            {
                var exe = Path.Combine(installDir, "DoNote.exe");
                if (File.Exists(exe))
                    Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = installDir, UseShellExecute = true });
            }
            catch { }
        }
    }

    private sealed class UninstallWizardForm : Form
    {
        private readonly string _exePath;
        private readonly SetupOptions _options;
        private readonly CheckBox _removeDataCheck;
        private readonly ProgressBar _progressBar;
        private readonly Label _statusLabel;
        private readonly Button _actionButton;
        private readonly Button _cancelButton;
        private bool _running;
        private bool _finished;

        internal UninstallWizardForm(string exePath, SetupOptions options)
        {
            _exePath = exePath;
            _options = options;

            Text = "卸载 DoNote";
            ClientSize = new Size(520, 316);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(248, 250, 252);
            Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular);
            try { Icon = Icon.ExtractAssociatedIcon(exePath); } catch { }

            var version = SetupPackage.TryReadInstalledVersion(options.InstallDirectory) ?? "";
            var header = new Panel { Dock = DockStyle.Top, Height = 76, BackColor = Color.White };
            header.Controls.Add(new Label
            {
                Text = "卸载 DoNote",
                Font = new Font("Microsoft YaHei UI", 14.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(24, 14),
                AutoSize = true
            });
            header.Controls.Add(new Label
            {
                Text = "目标目录：" + options.InstallDirectory + (string.IsNullOrEmpty(version) ? "" : "（" + version + "）"),
                Font = new Font("Microsoft YaHei UI", 8.8f),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(26, 46),
                Size = new Size(470, 20)
            });
            header.Controls.Add(new Panel { Dock = DockStyle.Bottom, Height = 1, BackColor = Color.FromArgb(226, 232, 240) });
            Controls.Add(header);

            var safetyNote = new Label
            {
                Text = "默认仅移除程序本体、快捷方式与卸载注册项，完整保留你的笔记资料库（Data）与本地模型（models）。",
                Location = new Point(24, 94),
                Size = new Size(472, 42),
                ForeColor = Color.FromArgb(21, 128, 61)
            };

            _removeDataCheck = new CheckBox
            {
                Text = "同时删除本机资料库（Data）与本地模型（models）（不可恢复）",
                Checked = options.RemoveData,
                Location = new Point(24, 146),
                AutoSize = true,
                ForeColor = Color.FromArgb(185, 28, 28)
            };

            _progressBar = new ProgressBar
            {
                Location = new Point(24, 192),
                Size = new Size(472, 18),
                Minimum = 0,
                Maximum = 100
            };
            _statusLabel = new Label
            {
                Text = "准备就绪。请确认 DoNote 已关闭。",
                Location = new Point(24, 218),
                Size = new Size(472, 24),
                ForeColor = Color.FromArgb(71, 85, 105),
                Font = new Font("Microsoft YaHei UI", 8.8f)
            };

            _actionButton = new Button
            {
                Text = "开始卸载",
                Location = new Point(304, 260),
                Size = new Size(100, 34),
                BackColor = Color.FromArgb(220, 38, 38),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _actionButton.FlatAppearance.BorderSize = 0;
            _actionButton.Click += async (s, e) => await StartUninstallAsync();

            _cancelButton = new Button
            {
                Text = "取消",
                Location = new Point(414, 260),
                Size = new Size(82, 34),
                FlatStyle = FlatStyle.System
            };
            _cancelButton.Click += (s, e) => Close();

            Controls.AddRange(new Control[] { safetyNote, _removeDataCheck, _progressBar, _statusLabel, _actionButton, _cancelButton });
            FormClosing += (s, e) =>
            {
                if (_running && e.CloseReason == CloseReason.UserClosing) e.Cancel = true;
            };
        }

        private async Task StartUninstallAsync()
        {
            if (_finished) { Close(); return; }
            if (_running) return;
            if (_removeDataCheck.Checked)
            {
                var confirm = MessageBox.Show(this,
                    "你已勾选「同时删除本机资料库与本地模型」。\n此操作不可恢复，确认继续吗？",
                    "确认删除本机资料", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (confirm != DialogResult.Yes) return;
            }

            _options.RemoveData = _removeDataCheck.Checked;
            _running = true;
            _removeDataCheck.Enabled = false;
            _actionButton.Enabled = false;
            _cancelButton.Enabled = false;
            var progress = new Progress<Tuple<int, string>>(p =>
            {
                _progressBar.Value = p.Item1;
                _statusLabel.Text = p.Item2;
            });

            try
            {
                var result = await Task.Run(() => SetupPackage.Uninstall(_exePath, _options, (pct, msg) => ((IProgress<Tuple<int, string>>)progress).Report(Tuple.Create(pct, msg))));
                _finished = true;
                _running = false;
                _progressBar.Value = 100;
                _statusLabel.Text = result.DataPreserved ? "卸载完成，本机资料与模型已保留。" : "已完全卸载 DoNote 及本机资料。";
                _actionButton.Text = "完成";
                _actionButton.BackColor = Color.FromArgb(37, 99, 235);
                _actionButton.Enabled = true;
                _cancelButton.Visible = false;
            }
            catch (Exception error)
            {
                _running = false;
                _removeDataCheck.Enabled = true;
                _actionButton.Enabled = true;
                _cancelButton.Enabled = true;
                _statusLabel.Text = "卸载未完成：" + error.Message;
                MessageBox.Show(this, "卸载未完成：\n\n" + error.Message, "卸载失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
