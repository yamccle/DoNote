# DoNote 发布回归

在仓库根目录运行。两个入口都使用新建测试目录，不访问当前安装或已有资料。

## 工作台

```powershell
node tools/tests/test-workspace.mjs <候选安装暂存目录>/workspace
```

依赖 Node.js 22 或更新版本、Playwright 和 Edge Stable。测试先从当前项目查找 Playwright，再查找 Codex 的本地运行时。其他环境可设置 `DONOTE_PLAYWRIGHT_MODULE` 为 Playwright 包的绝对路径，设置 `DONOTE_BROWSER_EXECUTABLE` 为浏览器路径，或设置 `DONOTE_BROWSER_CHANNEL` 为 Playwright 支持的浏览器通道。

测试文件默认有 321 页和约 1.01 GiB 的填充。若文件系统不支持稀疏文件，请预留等量临时空间。快速本地试跑可在路径后加 `128`，把填充降到 128 MiB，同时验证 PDF 按区间读取。默认发布检查使用完整大小。

工作台测试加载候选包的完整 `workspace`。检查 PDF 首尾与 worker、新建入口与窄窗口编辑、草稿和附件原始字节，以及关闭预览后字幕任务的进度和保存账户。字幕使用模拟宿主回复，验证消息契约和持久化。语音识别模型的加载与推理不在此测试范围内。

## Windows 更新器

```powershell
& tools/tests/test-release-update.ps1 -PreviousReleaseZip <旧版完整包> -UpdateZip <候选增量包>
```

依赖 Windows x64 的 .NET Framework C# 编译器。测试根据候选包清单从旧版 ZIP 提取实际旧程序文件，分别验证默认资料路径、自选资料路径和模拟中断回退。测试用隔离记录、附件、资料路径设置和自定义模型标记校验 SHA-256。候选完整包也可验证，所需临时空间和运行时间更长。
