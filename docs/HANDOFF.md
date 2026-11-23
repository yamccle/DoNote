# DoNote 接手说明

> 给接手这个项目的新 AI / 新维护者。先读这份，再读 `AGENTS.md` 和各目录的 `AGENTS.md`（L2 规则），发布流程以 [docs/releases/README.md](releases/README.md) 为准。

## 这是什么

DoNote：本地优先的工程研究工作台（WinForms + WebView2 桌面壳 + 本地网页工作台）。核心能力：文献/网页收藏与阅读、PDF 批注与翻译、离线智能排版、OCR 识字、全文检索、回收站、多开阅读、计划与工作日志、视频字幕等。

## 代码在哪

- 仓库根：`H:\WorkSpace\Codex\2026-11-03\sites-plugin-sites-openai-curated-remote-2`
- 只纳入正式源码（见 `.gitignore`）。`outputs/`、`work/*stage*`、安装目录、`Data/`、`models/` 都在 Git 之外。

目录速览：

| 路径 | 作用 |
| --- | --- |
| `work/desktop/` | Windows 宿主（C#）、更新器、构建脚本、打包脚本 |
| `work/analog-notes/public/` | 工作台/编辑器/PDF/视频界面（原生 JS，无框架） |
| `work/analog-notes/scripts/` | `build-offline.mjs` 把 public 内联成单文件 HTML |
| `work/ai-bridge/` | 外部助手接口、MCP、本机授权 |
| `work/video-runtime-build/` | 两个已修改的翻译源码目录（构建期资源，不在发布包里） |
| `tools/release.ps1` | 正式发布入口：从干净提交构建 + 校验 + 发布 |
| `tools/tests/` | 发布回归（工作台 / 升级回退 / 大 PDF） |
| `docs/releases/` | 发布手册、运行依赖锁定、发布记录 |

## 当前状态（换手时）

- 分支 `main`，HEAD `f608fc8`（r124 发布记录提交）
- 标签：`source-baseline-recovered` → `7913398`；`r123` → `3eba4d6`；`r124` → `0d35f83`
- 最新发布：**r124 / 26.1124.0070**，在 `outputs/r124/`（完整包 + 增量包 + `DoNote-r124-release.json`）
- 运行依赖锁定：`docs/releases/runtime-lock.json` 锁定 **r122**（`26.1121.0068`，SHA `6c4da1cf…`），**不要**改成 r123/r124：发布包不含 `video-runtime/` 构建期资源，改了会构不出来
- 工作树应为干净；脏树会被 `release.ps1` 直接拒绝

## 本机工具路径（PATH 里没有，需要显式加）

```powershell
$git   = 'C:\Users\PuJun\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\ucrt64\bin\git.exe'
$pwsh7 = 'C:\Users\PuJun\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe'
$node  = 'C:\Users\PuJun\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node.exe'
$csc   = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$edge  = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

`release.ps1` 内部直接调用 `git`（需在 PATH），并要求 PowerShell 7：
先把 git 的 `cmd` 目录和 node 加进 `PATH`，再用 `$pwsh7 -File tools/release.ps1 …` 运行。

## 改代码之后的验证

快速自检（不改发布流程）：

1. C# 改动：`work/desktop/build.ps1` 重编（C# 5 语法，`csc` 编译，无 NuGet）。
2. 网页改动：`node work/analog-notes/scripts/build-offline.mjs <输出 index.html>`。
3. 有行为变化就跑相关测试，再跑发布级检查（见下）。

发布级检查（`release.ps1` 会自动跑）：

```powershell
# 工作台：321 页 / 约 1.01 GiB 合成 PDF、草稿与附件字节、后台字幕
node tools/tests/test-workspace.mjs <候选 stage>/workspace
# 本地快速试跑可加 128（把填充降到 128 MiB）
node tools/tests/test-workspace.mjs <候选 stage>/workspace 128
# 升级 / 自选资料目录 / 中断回退
& tools/tests/test-release-update.ps1 -PreviousReleaseZip <上一版完整包> -UpdateZip <候选增量包>
```

## 发布下一版（r125 示例）

```powershell
$runtime  = '.\outputs\DoNote-Windows-x64-2026-11-21-r122-交互优化.zip'   # 运行依赖锁
$previous = '.\outputs\r124\DoNote-Windows-x64-r124.zip'                   # 上一版完整包
& $pwsh7 -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 `
  -Revision r125 -Version 26.1125.0071 `
  -RuntimeArchive $runtime -PreviousReleaseZip $previous -OutputDirectory outputs
```

成功后在 `outputs/r125/` 得到三个文件。**发布后收尾仍需人工四步**（当前如此）：

1. 打标签：`git tag -a r125 -m '…（版本）…' <本次构建用的提交>`（必须是发布记录里的 `sourceCommit`）
2. 更新 `docs/releases/runtime-lock.json` 的 `latestRelease`（运行依赖那段保持 r122 不动）
3. 更新 `docs/releases/README.md` 的发布记录表与下一版命令示例
4. `git add -A && git commit -m 'Record r125 release: …'`，确认 `git status` 干净

手工复核单个包（可选）：

```powershell
& $csc /nologo /target:exe /platform:x64 /codepage:65001 /main:UpdateProbe /out:$env:TEMP\UpdateProbe.exe `
  /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
  work/desktop/UpdateProbe.cs work/desktop/UpdatePackage.cs work/desktop/UpdateHost.cs
& $env:TEMP\UpdateProbe.exe .\outputs\r125\DoNote-Windows-x64-r125.zip   # 输出 Verified package …
```

## 硬性约定（别踩）

- **WebView2 来源必须是 `yams-one.example`**，否则现有 IndexedDB 打不开。
- **互斥锁名 `YamsOne.Desktop`** 由宿主和更新器共用，升级时必须兼容。
- 发布包**不含** `Data/` 与模型实体（只占位空目录）；更新器负责保护用户资料与模型。
- `tools/release.ps1` 要求**工作树干净**，且 `-Version` 必须**大于**上一版完整包的版本，`-Revision` 形如 `r125`。
- `-RuntimeArchive` 只能传锁定文件里那个 r122 包（发布包不含构建期运行依赖）。
- `work/desktop/*.ps1` 必须保存为 **UTF-8 带 BOM**：Windows PowerShell 5.1 读无 BOM 文件会把中文路径读成乱码（曾因此构建失败）。
- 打 ZIP 必须用正斜杠条目（`package-release.ps1`）；用 `Compress-Archive` 会写反斜杠，更新器 `GetEntry` 找不到文件（r36 事故）。
- 不要改 `outputs/`、`work/*-stage/` 里的历史产物；不要提交 `Data/`、`models/`。

## 下一步可以做的

1. 产品主线：「阅读 → 摘录 → 形成记录 → 找回出处」这条链做稳。
2. 把发布收尾四步自动化进 `release.ps1`（打 tag、回写 lock 与 README、提交）。
3. 继续补齐 `tools/tests/` 覆盖（当前重点是工作台、升级回退、大 PDF、草稿/字幕）。
4. 用户明确说过：**不需要**把发布包复制/分卷到 `OUT/`。

## 换手时先做这几件事

```powershell
cd H:\WorkSpace\Codex\2026-11-03\sites-plugin-sites-openai-curated-remote-2
& $git log --oneline -5
& $git tag -l
& $git status --porcelain
Get-ChildItem outputs\r124
Get-Content docs\releases\runtime-lock.json
```

然后读 `AGENTS.md`、`work/desktop/AGENTS.md`、`work/analog-notes/public/AGENTS.md`、`tools/tests/AGENTS.md`、`docs/releases/README.md`。
