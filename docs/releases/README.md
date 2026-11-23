# DoNote 发布与重建

## 恢复基线

`source-baseline-recovered` 记录开始整顿时工作区中的正式源码。其中已包含尚未发布的新建记录界面。现有目录没有可核验的历史 Git 提交，不能据此把旧 ZIP 归到某个提交。

r122 完整包的版本清单为 `26.1121.0068`。其文件名和 SHA-256 位于 [运行依赖锁定文件](runtime-lock.json)。保存该 ZIP 供离线重建。构建只从中读取 WebView2 DLL、Node、Python 及翻译运行依赖（含 `video-runtime/` 构建期资源；发布包不携带这些目录）。主程序、更新器、工作台、Python 工作脚本和 AI 桥逻辑从源码提交重新构建。

## 发布

使用 Windows x64、PowerShell 7、Git、Windows .NET Framework 编译器和 Edge。工作台检查需要 Playwright。可通过 `DONOTE_PLAYWRIGHT_MODULE` 指向 Playwright 模块。

从仓库根目录执行以下命令。`-RuntimeArchive` 始终指向已锁定的运行依赖包（r122），`-PreviousReleaseZip` 指向上一版完整包（当前为 r125）。

```powershell
$runtime = '.\outputs\DoNote-Windows-x64-2026-11-21-r122-交互优化.zip'
$previous = '.\outputs\r125\DoNote-Windows-x64-r125.zip'
pwsh -File tools/release.ps1 -Revision r126 -Version 26.1126.0072 `
  -RuntimeArchive $runtime -PreviousReleaseZip $previous -OutputDirectory outputs
```

脚本读取干净的 Git 提交，并导出独立源码目录。它先运行工作台和实际升级回退检查，再校验 ZIP。通过后，三个文件一起进入 `outputs/r126/`。下次发布使用新的修订号和版本号，并把 `-PreviousReleaseZip` 指向上一版完整包。运行依赖仍使用同一个已锁定的 r122 完整包。构建发生故障时，可用 `-KeepStage` 保留临时构建目录。

增量包、完整包和发布记录都包含源码提交和运行依赖校验值。发布记录也包含上一版完整包和两个新 ZIP 的 SHA-256。保持检查通过的提交与发行标签对应。Windows 编译器版本和 ZIP 时间戳会影响整个包的字节值，重建以相同源码和依赖为准。

## 发布记录

| 修订 | 版本 | 标签 / 提交 | 日期 | 备注 |
| --- | --- | --- | --- | --- |
| r125 | 26.1125.0071 | tag `r125` → `e02edda` | 2026-11-23 | 字幕识别时逐条同步翻译（边识别边翻译）；基于 r124（26.1124.0070） |
| r124 | 26.1124.0070 | tag `r124` → `0d35f83` | 2026-11-23 | 按新发布流程重建；基于 r123（26.1123.0069） |
| r123 | 26.1123.0069 | tag `r123` → `3eba4d6` | 2026-11-23 | 交互优化与工程化整理；基于 r122（26.1121.0068） |

### r125

- 完整包 `outputs/r125/DoNote-Windows-x64-r125.zip`
  `d5b5eef43edf9c9e30a2550aebf5b39bd7ce6787d284e85db3e730729fdf73d4`
- 增量包 `outputs/r125/DoNote-Update-26.1124.0070-to-r125.zip`
  `01b32d93e9847edca21a5a0506c0f4a0388bf818d4fb341181306da71162eb0f`
- 发布记录 `outputs/r125/DoNote-r125-release.json`，检查项：`workspace`、`upgrade-and-rollback`、`package-checksums`。

### r124

- 完整包 `outputs/r124/DoNote-Windows-x64-r124.zip`
  `123a1356c877c5508a9baeca1bd1f6977ef61f808833d503326dbea88746a6fc`
- 增量包 `outputs/r124/DoNote-Update-26.1123.0069-to-r124.zip`
  `2c299c35f519b3b89425bb75850ae71a18c1c288221967fc5aa54af7f7e0a7b1`
- 发布记录 `outputs/r124/DoNote-r124-release.json`，检查项：`workspace`、`upgrade-and-rollback`、`package-checksums`。

### r123

- 完整包 `outputs/r123/DoNote-Windows-x64-r123.zip`
  `37052fda3571caf5b22ba3a3acf1b98d65134af5108c584ff718128d6d317739`
- 增量包 `outputs/r123/DoNote-Update-26.1121.0068-to-r123.zip`
  `edcabf0bd83496e2c4fe2cb3e76cb12642f5c1063875acac149bc58fe6017089`
- 发布记录 `outputs/r123/DoNote-r123-release.json`，检查项：`workspace`、`upgrade-and-rollback`、`package-checksums`。

## 兼容边界

- WebView2 来源保留 `yams-one.example`，供现有 IndexedDB 访问。
- Windows 宿主与更新器继续共用 `YamsOne.Desktop` 互斥锁。
- 应用更新保护 `Data` 和模型文件。完整包只携带模型空目录占位文件。
- 桌面工作台从本地分文件加载代码、CSS 和 PDF worker。便携 HTML 使用独立的内联构建入口。
