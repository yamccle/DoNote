# DoNote 接手说明

> 给接手这个项目的新 AI / 新维护者。先读这份，再读 `AGENTS.md` 和各目录的 `AGENTS.md`（L2 规则），发布流程以 [docs/releases/README.md](releases/README.md) 为准。

## 这是什么

DoNote：本地优先的工程研究工作台（WinForms + WebView2 桌面壳 + 本地网页工作台）。核心能力：文献/网页收藏与阅读、PDF 批注与翻译、离线智能排版、OCR 识字、全文检索、回收站、多开阅读、计划与工作日志、视频字幕（识别时逐条同步翻译）等。

## 代码在哪

- 仓库根：`H:\WorkSpace\Codex\2026-11-03\sites-plugin-sites-openai-curated-remote-2`
- GitHub 远程：`https://github.com/yamccle/DoNote`（public，只含源码；模型包、发布包、`Data/`、`models/` 不进 Git）
- 只纳入正式源码（见 `.gitignore`）。`outputs/`、`work/*stage*`、安装目录、`Data/`、`models/` 都在 Git 之外。

目录速览：

| 路径 | 作用 |
| --- | --- |
| `work/desktop/` | Windows 宿主（C#）、更新器、模型安装器、构建脚本、打包脚本 |
| `work/analog-notes/public/` | 工作台/编辑器/PDF/视频界面（原生 JS，无框架） |
| `work/analog-notes/scripts/` | `build-offline.mjs` 把 public 内联成单文件 HTML |
| `work/ai-bridge/` | 外部助手接口、MCP、本机授权 |
| `work/video-runtime-build/` | 视频识别/翻译运行依赖与源码（构建期资源，不在发布包里） |
| `tools/release.ps1` | 正式发布入口：从干净提交构建 + 校验 + 发布 |
| `tools/tests/` | 发布回归（工作台 / 升级回退 / 大 PDF） |
| `docs/releases/` | 发布手册、运行依赖锁定、发布记录、模型包记录 |

## 当前状态（换手时）

- 分支 `main`。发布使用的源码提交由修订标签定位。
- 恢复基线 `source-baseline-recovered` 指向 `7913398`。当前发布标签 `r128` 指向 `69512f2`。
- 最新发布 **r128 / 26.1128.0074**。在 `outputs/r128/` 提供完整包、增量包与 `DoNote-r128-release.json`。
- 运行依赖锁定：`docs/releases/runtime-lock.json` 锁定 **r122**（`26.1121.0068`，SHA `6c4da1cf…`），**不要**改成 r123 及以后：发布包不含 `video-runtime/` 构建期资源，改了会构不出来
- 工作树应为干净；脏树会被 `release.ps1` 直接拒绝

### 近期改动

| 版本 | 内容 |
| --- | --- |
| r125 | 视频字幕「识别时同步翻译」：识别一条翻一条，边看边有中文字幕；默认开，可在字幕面板关闭 |
| r126 | 修复同步翻译漏掉**重新识别后的第一批**字幕（旧字幕条数把新字幕的入队下标带偏） |
| r127 | 语音模型在线下载默认走 `hf-mirror.com`（原默认直连 huggingface.co，国内超时）；模型安装器加固（文件被占用不再中断）；模型说明按实测校正 |
| r128 | 总览新建时选择记录类型，栏目内直接新建。附件和关联资料移到正文前。切换类型保留输入，修复窄窗和夜间整页编辑。 |

### 模型包（不在 Git，发布用）

| 文件 | 说明 |
| --- | --- |
| `outputs/DoNote-Models-x64-2026-11-23.zip`（9.25 GB） | 修复版安装器，模型文件与旧包一致 |
| `outputs/DoNote-Models-x64-2026-11-14.zip`（9.76 GB） | 旧版模型包 |
| `outputs/DoNote-Models-Installer-Fix-2026-11-23.zip`（3 KB） | 只替换安装器，给已下旧包的用户 |

模型包内容：4 个 faster-whisper（base/small/large-v3-turbo/large-v3）+ 3 个 Qwen3 GGUF（4B/1.7B/0.6B）。已验证：ZIP 全量 CRC 通过、7 个模型文件 SHA-256 与文档一致、应用可用 `models/asr/base` 实际识别。安装器源码在 `work/desktop/Install-DoNote-Models.ps1` + `安装模型.cmd`（新增，改完需重打模型包或发小修复包；模型包数据在 `work/video-models/` 与旧包内）。

## 本机工具路径（PATH 里没有，需要显式加）

```powershell
$git   = 'C:\Users\PuJun\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\ucrt64\bin\git.exe'
$gitCmd= 'C:\Users\PuJun\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd'
$pwsh7 = 'C:\Users\PuJun\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe'
$nodeBin='C:\Users\PuJun\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
$csc   = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$edge  = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

`release.ps1` 内部直接调用 `git`（需在 PATH），并要求 PowerShell 7：
先把 `$gitCmd`、`$gitBin`、`$nodeBin` 加进 `PATH`，再用 `$pwsh7 -File tools/release.ps1 …` 运行。

## 改代码之后的验证

快速自检（不改发布流程）：

1. C# 改动：`work/desktop/build.ps1` 重编（C# 5 语法，`csc` 编译，无 NuGet）。
2. 网页改动：`node work/analog-notes/scripts/build-offline.mjs <输出 index.html>`。
3. 有行为变化就跑相关测试，再跑发布级检查（见下）。

发布级检查（`release.ps1` 会自动跑）：

```powershell
# 工作台：321 页 / 约 1.01 GiB 合成 PDF、草稿与附件字节、后台字幕与识别中同步翻译
node tools/tests/test-workspace.mjs <候选 stage>/workspace
# 本地快速试跑可加 128（把填充降到 128 MiB）
node tools/tests/test-workspace.mjs <候选 stage>/workspace 128
# 升级 / 自选资料目录 / 中断回退
& tools/tests/test-release-update.ps1 -PreviousReleaseZip <上一版完整包> -UpdateZip <候选增量包>
```

字幕相关改动的额外自检：`tools/tests/test-workspace.mjs` 的 `testBackgroundSubtitles` 用模拟宿主（`qaRelease.post`）回放识别消息，并模拟 `subtitle-local:*` 离线翻译；改动消息契约或翻译流程时必须同步更新该测试。

## 发布下一版（r129 示例）

```powershell
$runtime  = '.\outputs\DoNote-Windows-x64-2026-11-21-r122-交互优化.zip'   # 运行依赖锁
$previous = '.\outputs\r128\DoNote-Windows-x64-r128.zip'                   # 上一版完整包
& $pwsh7 -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 `
  -Revision r129 -Version 26.1129.0075 `
  -RuntimeArchive $runtime -PreviousReleaseZip $previous -OutputDirectory outputs
```

成功后在 `outputs/r129/` 得到三个文件。发布后按以下四步更新发布记录。

1. 打标签 `git tag -a r129 -m '…（版本）…' <本次构建用的提交>`。目标提交用发布记录里的 `sourceCommit`。
2. 更新 `docs/releases/runtime-lock.json` 的 `latestRelease`（运行依赖那段保持 r122 不动）
3. 更新 `docs/releases/README.md` 的发布记录表与下一版命令示例
4. `git add -A && git commit -m 'Record r129 release'`，确认 `git status` 干净。

手工复核单个包（可选）：

```powershell
& $csc /nologo /target:exe /platform:x64 /codepage:65001 /main:UpdateProbe /out:$env:TEMP\UpdateProbe.exe `
  /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
  work/desktop/UpdateProbe.cs work/desktop/UpdatePackage.cs work/desktop/UpdateHost.cs
& $env:TEMP\UpdateProbe.exe .\outputs\r128\DoNote-Windows-x64-r128.zip   # 输出 Verified package …
```

## 硬性约定（别踩）

- **WebView2 来源必须是 `yams-one.example`**，否则现有 IndexedDB 打不开。
- **互斥锁名 `YamsOne.Desktop`** 由宿主和更新器共用，升级时必须兼容。
- 发布包**不含** `Data/` 与模型实体（只占位空目录）；更新器负责保护用户资料与模型。
- `tools/release.ps1` 要求**工作树干净**，且 `-Version` 必须**大于**上一版完整包的版本，`-Revision` 形如 `r128`。
- `-RuntimeArchive` 只能传锁定文件里那个 r122 包（发布包不含构建期运行依赖）。
- `work/desktop/*.ps1` 必须保存为 **UTF-8 带 BOM**：Windows PowerShell 5.1 读无 BOM 文件会把中文路径读成乱码（曾因此构建失败）。
- 打 ZIP 必须用正斜杠条目（`package-release.ps1`）；用 `Compress-Archive` 会写反斜杠，更新器 `GetEntry` 找不到文件（r36 事故）。
- 语音模型在线下载默认 `hf-mirror.com`（`DONOTE_HF_ENDPOINT` 可覆盖，`official` 切回官方）；缓存目录 `%USERPROFILE%\.cache\huggingface`。模型包内 `models\asr` 优先于缓存。
- 模型安装器：安装前先退出 DoNote；文件被占用会提示并继续，失败时退出码 3；找不到目录退出码 2。
- 不要改 `outputs/`、`work/*-stage/` 里的历史产物；不要提交 `Data/`、`models/`。

## 下一步可以做的

1. 产品主线：「阅读 → 摘录 → 形成记录 → 找回出处」这条链做稳。
2. 把发布收尾四步自动化进 `release.ps1`（打 tag、回写 lock 与 README、提交）。
3. 给本地翻译 GGUF 加内置下载器（设置页下载 + 镜像 + 进度），摆脱"必须装 9 GB 模型包"。
4. GitHub Releases 发布（待定）：程序包可上（1.07 GB < 2 GB/资产），模型包 9.25 GB 必须放对象存储/网盘；国内下载建议镜像。
5. 继续补齐 `tools/tests/` 覆盖（工作台、升级回退、大 PDF、草稿/字幕）。
6. 用户明确说过：**不需要**把发布包复制/分卷到 `OUT/`。

## 换手时先做这几件事

```powershell
cd H:\WorkSpace\Codex\2026-11-03\sites-plugin-sites-openai-curated-remote-2
& $git log --oneline -8
& $git tag -l
& $git status --porcelain
Get-ChildItem outputs\r128
Get-ChildItem outputs -Filter 'DoNote-Models*'
Get-Content docs\releases\runtime-lock.json
& $git remote -v
```

然后读 `AGENTS.md`、`work/desktop/AGENTS.md`、`work/analog-notes/public/AGENTS.md`、`tools/tests/AGENTS.md`、`docs/releases/README.md`。
