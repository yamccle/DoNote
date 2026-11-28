# DoNote 发布回归

> L2 | 项目规则来自根目录 AGENTS.md。

- `test-release-update.ps1` 调用桌面更新器，验证真实版本替换和中断回退。
- `test-update-chain.ps1` 编译 `UpdateChainProbe.cs`。验证最小下载路径、缺包桥接和多步回退。
- `test-setup-installer.ps1` 调用 `make-installer.ps1`，在隔离目录与测试注册表键下验证安装器自检、全新用户级安装、覆盖升级保留 `Data`/`models`、安全卸载保留资料与完全卸载清理。
- `test-translation-acceleration.py` 验证 GPU 自适应探测、多段 JSON 批译解析与 OpenAI-Compatible 并发回环调用。
- `UpdateChainProbe.cs` 使用合成安装目录检查失败后可从前一版本继续。
- `test-workspace.mjs` 在独立浏览器中验证工作台与阅读器。字幕测试覆盖从进行中和已完成任务打开原视频。
- `workspace-translation.mjs` 由 `test-workspace.mjs` 调用，在真实浏览器模拟宿主下端到端验证 `PdfMathTranslate` 整页桥、`BilingualBook` 双语排版桥与 `openai` 翻译源链路。
- `workspace-excerpts.mjs` 由 `test-workspace.mjs` 调用，验证网页摘录回跳与单进程并发抓取、PDF 摘录追加、页面反向引用角标、扫描页离线识字入索引、隔离空账户备份恢复、右侧三面板、PPT 逐页批注/导出讲义/全文检索、Bento 总览、画廊/看板双视图、`Ctrl+K` 指令面板与聚合设置中心。
- `workspace-r139.mjs` 由 `workspace-excerpts.mjs` 调用，验证成就殿宇 10 张里程碑卡牌、每日打开/使用活跃足迹、GitHub 在线自动更新、侧边栏微层次、精简版 AI 管理页、篮板式全局拖拽投递与分拣台、统一后台任务中心及 `/api/sync/v1` 多端增量同步。
- `workspace-r140.mjs` 由 `workspace-excerpts.mjs` 调用，端到端验证目录卡片 60px 等高、成就殿宇隐藏开关、文献库默认按最近打开排序、四栏自适应设置框、视频多模态 AI 助教问答、研究方向降噪治理、行动导向指标计数、撤销凭证彻底清理、启动静默更新圆点、PDF/PPT 批注 CRDT 合并，以及多端协同页的云盘目录、画廊仅用本机封面与单份附件按需打开。
- `test-real-pdf.mjs` 测量真实长 PDF 与双栏论文的首次可阅读、目录树、中段摘录反向引用、多标签切换、跳末页、浏览器进程树峰值内存和索引续跑。样本不在时记为待验证。
- `test-folder-sync-merge.mjs` 验证云盘文件夹对齐的更新时间、删除标记和目录合并，不启动桌面程序。
- `test-cloud-backup.mjs` 验证云备份目录和回环 WebDAV 的快照往返、先删标记后删归档的保留份数清理及失败保护。
- `CloudBackupProbe.cs` 从命令行调用桌面云备份传输，供独立测试使用。
- `README.md` 说明测试入口、依赖和覆盖范围。

[PROTOCOL]: Update this header on change, then check AGENTS.md
