# DoNote Windows 桌面端

> L2 | 项目规则来自工作区 AGENTS.md。

## 构建与更新

- `build.ps1` 构建桌面宿主和工作台，并写入发布清单。
- `stage-runtime.ps1` 按运行依赖锁定文件核验旧包，只提取发布所需依赖。
- `make-update-patch.ps1` 比较两个完整清单，生成已验证的增量 ZIP。
- `UpdatePackage.cs` 校验包内容、版本和基础版本。保护资料与模型路径。
- `OnlineUpdatePlan.cs` 计算从本机到最新正式版的更新路径。按总下载量比较增量包和完整包。
- `LocalUpdate.cs` 查询 GitHub Releases。逐包下载并校验 SHA-256。完成后启动独立更新器。
- `UpdateHost.cs` 持有单实例锁逐包安装。单步失败时回退该步，安装结束后重新打开 DoNote。
- `SetupPackage.cs` 读取 `DNSETUP1` 自解压尾部并流式校验内嵌完整包，执行用户级安装/覆盖升级、写出纯卸载器、创建快捷方式、注册 `HKCU` 卸载项以及默认保留 `Data`/`models` 的安全卸载。
- `SetupHost.cs` 提供中文用户级安装向导与安全卸载 WinForms 界面，同时支持 `--verify-only`、`--silent`、`--uninstall` 命令行模式。
- `make-installer.ps1` 编译 `SetupHost.cs` + `SetupPackage.cs` + `UpdatePackage.cs` 为纯壳，流式拼接便携完整包与 `DNSETUP1` 校验尾，生成并自检 `DoNote-Setup-x64-*.exe`。
- `Program.cs` 为已验证来源的工作台消息选择 Windows 宿主服务。

## 云备份

- `LargeBackup.cs` 写入本机备份，并把已完成的快照交给云备份。
- `CloudBackup.cs` 绑定系统选取的同步目录，保存 Windows 用户加密设置及保留份数策略，并在新快照上传完成后触发旧快照清理。
- `CloudBackupTransport.cs` 传输版本化 ZIP 和完成标记，按先删标记再删归档顺序清理超限旧快照，验证下载后解包。

## 文件夹对齐

- `FolderSync.cs` 记住云盘客户端已经在同步的文件夹，监视 `DoNote` 子目录，并按块读写记录与附件。云盘客户端负责外网传输。
- `folder-sync-merge.js` 按更新时间比较记录和删除标记，不读写磁盘。
- `folder-sync.js` 在设置页选择文件夹后对齐记录目录。本机已有的附件写回文件夹。打开某一份时再读取那一份，对齐时不把缺的附件拉进本机。

## 开场动画

- `Program.cs` 读取当前资料目录的开场设置。WebView2 开始播放后，宿主隐藏标题栏。播放退出、页面切换或超时后，宿主恢复标题栏。
- `startup-splash.js` 在画布上绘制约 2.5 秒的运笔和光迹。它通过 `startup-splash-enter` 和 `startup-splash-exit` 通知宿主。
- `startup-splash.css` 保持画布宽高比，并使用工作台主题色铺满窗口。
- `startup-wordmark.js` 提供由签名照描摹的矢量轮廓。
- `build.ps1` 将开场脚本、样式和画面放入安装包的 `workspace` 目录。
- `开始使用.md` 记录云盘文件夹对齐、开场设置、键盘操作和减少动态效果的行为。

## 设置中心与网页收藏

- `desktop-settings.html`、`desktop-settings.js`、`desktop-settings.css`、`desktop-translation.js`、`TranslationProviders.cs` 与 `WindowChrome.cs` 提供「外观与阅读 · AI 与翻译 · 多端协同 · 资料与系统」四栏自适应舒展设置中心、DPAPI 密钥状态就绪提示、一键连接测速、抢占式连续选词翻译及跨视图热切换 OpenAI-Compatible 并发大模型翻译源。
- `pdf_gguf_translation.py`、`pdfmathtranslate.py`、`bilingual-book-worker.py` 与 `enable-vulkan-gpu.ps1` 实现文献翻译三级加速：可选 `vulkan-dependencies` + GPU 自适应（`llama_supports_gpu_offload`）+ `n_batch=512`、极速轻模型级联与 GGUF `@@id@@` 流式多段批译、以及带瞬态退避重试与单段容错隔离的 OpenAI-Compatible `ThreadPoolExecutor` 并发池。
- `web-fetch.mjs` 执行公网 IP 校验防 SSRF，复用 TLS Keep-Alive 连接与 `gzip/deflate/br` 流式限额解压，单进程 8 路并发限时抓取网页正文与配图样式。

## 云端备份

- `desktop-large-backup.js` 为本地备份和云端快照暂存复用按块写入。
- `desktop-cloud-backup.js` 配置备份目标与保留版本数并显示传输进度（仅在实际上传/下载快照传输期间接入后台任务中心，纯查看设置或刷新列表不产生常驻任务）。下载完成后使用原有文件夹恢复。

[PROTOCOL]: Update this header on change, then check AGENTS.md
