# DoNote Windows 桌面端

> L2 | 项目规则来自工作区 AGENTS.md。

## 构建与更新

- `build.ps1` 构建桌面宿主和工作台，并写入发布清单。
- `stage-runtime.ps1` 按运行依赖锁定文件核验旧包，只提取发布所需依赖。
- `make-update-patch.ps1` 比较两个完整清单，生成已验证的增量 ZIP。
- `UpdatePackage.cs` 校验文件路径、版本及内容。普通应用包拒绝模型文件。
- `Program.cs` 为已验证来源的工作台消息选择 Windows 宿主服务。

## 云备份

- `LargeBackup.cs` 写入本机备份，并把已完成的快照交给云备份。
- `CloudBackup.cs` 绑定系统选取的同步目录，保存 Windows 用户加密设置及保留份数策略，并在新快照上传完成后触发旧快照清理。
- `CloudBackupTransport.cs` 传输版本化 ZIP 和完成标记，按先删标记再删归档顺序清理超限旧快照，验证下载后解包。

## 开场动画

- `Program.cs` 读取当前资料目录的开场设置。WebView2 开始播放后，宿主隐藏标题栏。播放退出、页面切换或超时后，宿主恢复标题栏。
- `startup-splash.js` 在画布上绘制约 2.5 秒的运笔和光迹。它通过 `startup-splash-enter` 和 `startup-splash-exit` 通知宿主。
- `startup-splash.css` 保持画布宽高比，并使用工作台主题色铺满窗口。
- `startup-wordmark.js` 提供由签名照描摹的矢量轮廓。
- `build.ps1` 将开场脚本、样式和画面放入安装包的 `workspace` 目录。
- `开始使用.md` 记录开场设置、键盘操作和减少动态效果的行为。

## 设置中心与网页收藏

- `desktop-settings.html`、`desktop-settings.js` 和 `desktop-settings.css` 提供「外观与阅读 · AI 与翻译 · 资料与系统」三栏聚合设置中心，内联默认翻译语向、Whisper 模型选择、资料目录操作与版本更新入口，消除多级悬停子菜单与碎片弹窗。
- `web-fetch.mjs` 执行公网 IP 校验防 SSRF，复用 TLS Keep-Alive 连接与 `gzip/deflate/br` 流式限额解压，单进程 8 路并发限时抓取网页正文与配图样式。

## 云端备份

- `desktop-large-backup.js` 为本地备份和云端快照暂存复用按块写入。
- `desktop-cloud-backup.js` 配置备份目标与保留版本数并显示传输进度。下载完成后使用原有文件夹恢复。

[PROTOCOL]: Update this header on change, then check AGENTS.md
