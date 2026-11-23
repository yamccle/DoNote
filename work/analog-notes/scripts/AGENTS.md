# DoNote 工作台构建

> L2 | 项目规则见仓库根部 AGENTS.md。

- `workspace-assets.mjs` 读取模板。只处理本地脚本和样式引用。
- `build-desktop-workspace.mjs` 生成 WebView2 工作台。应用资源和第三方 worker 分文件发布。
- `build-offline.mjs` 生成便携 HTML。该入口继续内联应用资源。

[PROTOCOL]: Update this header on change, then check AGENTS.md
