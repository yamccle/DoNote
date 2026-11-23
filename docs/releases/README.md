# DoNote 发布与重建

## 恢复基线

`source-baseline-recovered` 记录开始整顿时工作区中的正式源码。其中已包含尚未发布的新建记录界面。现有目录没有可核验的历史 Git 提交，不能据此把旧 ZIP 归到某个提交。

r122 完整包的版本清单为 `26.1121.0068`。其文件名和 SHA-256 位于 [运行依赖锁定文件](runtime-lock.json)。保存该 ZIP 供离线重建。构建只从中读取 WebView2 DLL、Node、Python 及翻译运行依赖。主程序、更新器、工作台、Python 工作脚本和 AI 桥逻辑从源码提交重新构建。

## 发布

使用 Windows x64、PowerShell 7、Git、Windows .NET Framework 编译器和 Edge。工作台检查需要 Playwright。可通过 `DONOTE_PLAYWRIGHT_MODULE` 指向 Playwright 模块。

从仓库根目录执行以下命令。将两个 ZIP 路径指向已保存文件。

```powershell
$runtime = '.\outputs\DoNote-Windows-x64-2026-11-21-r122-交互优化.zip'
pwsh -File tools/release.ps1 -Revision r123 -Version 26.1123.0069 `
  -RuntimeArchive $runtime -PreviousReleaseZip $runtime -OutputDirectory outputs
```

脚本读取干净的 Git 提交，并导出独立源码目录。它先运行工作台和实际升级回退检查，再校验 ZIP。通过后，三个文件一起进入 `outputs/r123/`。下次发布使用新的修订号和版本号，并把 `-PreviousReleaseZip` 指向上一版完整包。仍可使用同一个已锁定的运行依赖包。构建发生故障时，可用 `-KeepStage` 保留临时构建目录。

增量包、完整包和发布记录都包含源码提交和运行依赖校验值。发布记录也包含上一版完整包和两个新 ZIP 的 SHA-256。保持检查通过的提交与发行标签对应。Windows 编译器版本和 ZIP 时间戳会影响整个包的字节值，重建以相同源码和依赖为准。

## 兼容边界

- WebView2 来源保留 `yams-one.example`，供现有 IndexedDB 访问。
- Windows 宿主与更新器继续共用 `YamsOne.Desktop` 互斥锁。
- 应用更新保护 `Data` 和模型文件。完整包只携带模型空目录占位文件。
- 桌面工作台从本地分文件加载代码、CSS 和 PDF worker。便携 HTML 使用独立的内联构建入口。
