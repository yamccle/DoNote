# DoNote 发布回归

> L2 | 项目规则来自根目录 AGENTS.md。

- `test-release-update.ps1` 调用桌面更新器，验证真实版本替换和中断回退。
- `test-workspace.mjs` 在独立浏览器进程验证总览、栏目工具栏、记录、阅读器、摘录和备份界面。
- `workspace-excerpts.mjs` 由 `test-workspace.mjs` 调用，验证网页摘录回跳、PDF 摘录追加、页面反向引用角标与扫描页离线识字入全文索引。
- `test-real-pdf.mjs` 测量真实长 PDF 与双栏论文的首次可阅读、目录树、中段摘录反向引用、多标签切换、跳末页、浏览器进程树峰值内存和索引续跑。样本不在时记为待验证。
- `test-cloud-backup.mjs` 验证云备份目录和回环 WebDAV 的快照往返及失败保护。
- `CloudBackupProbe.cs` 从命令行调用桌面云备份传输，供独立测试使用。
- `README.md` 说明测试入口、依赖和覆盖范围。

[PROTOCOL]: Update this header on change, then check AGENTS.md
