# DoNote 发布回归

> L2 | 项目规则来自根目录 AGENTS.md。

- `test-release-update.ps1` 调用桌面更新器，验证真实版本替换和中断回退。
- `test-workspace.mjs` 在独立浏览器进程验证新建记录、草稿、文件夹、PDF 和字幕。
- `large-pdf.mjs` 生成带大尺寸未引用流和首尾标记的 PDF。
- `README.md` 说明测试入口、依赖和覆盖范围。

[PROTOCOL]: Update this header on change, then check AGENTS.md
