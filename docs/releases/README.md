# DoNote 发布与重建

## 恢复基线

`source-baseline-recovered` 记录开始整顿时工作区中的正式源码。其中已包含尚未发布的新建记录界面。现有目录没有可核验的历史 Git 提交，不能据此把旧 ZIP 归到某个提交。

r122 完整包的版本清单为 `26.1121.0068`。其文件名和 SHA-256 位于 [运行依赖锁定文件](runtime-lock.json)。保存该 ZIP 供离线重建。构建只从中读取 WebView2 DLL、Node、Python 及翻译运行依赖（含 `video-runtime/` 构建期资源；发布包不携带这些目录）。主程序、更新器、工作台、Python 工作脚本和 AI 桥逻辑从源码提交重新构建。

## 发布

使用 Windows x64、PowerShell 7、Git、Windows .NET Framework 编译器和 Edge。工作台检查需要 Playwright。可通过 `DONOTE_PLAYWRIGHT_MODULE` 指向 Playwright 模块。

从源码工作区根目录执行以下命令。将 `$outputs` 设为存放正式发布包的目录。r130 的独立工作区使用主工作区的 `..\..\outputs`。

```powershell
$outputs = '.\outputs'
$runtime = Join-Path $outputs 'DoNote-Windows-x64-2026-11-21-r122-交互优化.zip'
$previous = Join-Path $outputs 'r135\DoNote-Windows-x64-r135.zip'
pwsh -File tools/release.ps1 -Revision r136 -Version 26.1136.0082 `
  -RuntimeArchive $runtime -PreviousReleaseZip $previous -OutputDirectory $outputs
```

脚本读取干净的 Git 提交，并导出独立源码目录。通过工作台、升级回退和 ZIP 校验后，三个文件一起进入本次修订的目录。每次发布递增修订号和版本号，`-PreviousReleaseZip` 选择上一版完整包。运行依赖继续使用锁定的 r122 完整包。构建失败时，可用 `-KeepStage` 保留临时构建目录。

增量包、完整包和发布记录都包含源码提交和运行依赖校验值。发布记录也包含上一版完整包和两个新 ZIP 的 SHA-256。保持检查通过的提交与发行标签对应。Windows 编译器版本和 ZIP 时间戳会影响整个包的字节值，重建以相同源码和依赖为准。

## 发布记录

| 修订 | 版本 | 标签 / 提交 | 日期 | 备注 |
| --- | --- | --- | --- | --- |
| r135 | 26.1135.0081 | tag `r135` → `2378705` | 2026-11-24 | 重构 PDF 右侧翻译、批注与 AI 问答界面：顺向无嵌套翻译卡与电路术语胶囊、紧凑批注与当前页筛选、SSE 流式与 KaTeX 公式渲染问答。基于 r134（26.1134.0080） |
| r134 | 26.1134.0080 | tag `r134` → `33ebc83` | 2026-11-24 | 新增 PDF 页面反向引用与无重载穿梭、扫描页离线识字入全文索引及云端快照保留份数清理；加固增量备份引用重映射。基于 r133（26.1133.0079） |
| r133 | 26.1133.0079 | tag `r133` → `b6278e6` | 2026-11-24 | 新增 Google Drive 同步目录与 WebDAV 版本化云端备份（含完成标记与 SHA-256 校验恢复）。基于 r132（26.1132.0078） |
| r132 | 26.1132.0078 | tag `r132` → `eb4c918` | 2026-11-24 | 文件夹管理默认折叠。点 › 展开下一层，搜索仍能找到深层文件夹。基于 r131（26.1131.0077） |
| r131 | 26.1131.0077 | tag `r131` → `5929076` | 2026-11-24 | 网页摘录可形成记录并回到原文。PDF 选区可追加到设计问题或仿真记录，并回到同一页和选区。基于 r130（26.1130.0076） |
| r130 | 26.1130.0076 | tag `r130` → `eb3b047` | 2026-11-24 | 主页显示继续阅读和近期计划。栏目压缩工具栏，保留原操作。基于 r129（26.1129.0075） |
| r129 | 26.1129.0075 | tag `r129` → `5507f04` | 2026-11-23 | 统一文件夹新建/导航/移动流程；长路径不挤出按钮、位置行可滚动、选择器输入框样式统一；基于 r128（26.1128.0074） |
| r128 | 26.1128.0074 | tag `r128` → `69512f2` | 2026-11-23 | 总览新建时选择记录类型。附件和关联资料移到正文前。保留切换类型前的输入，修复夜间整页编辑。基于 r127（26.1127.0073） |
| r127 | 26.1127.0073 | tag `r127` → `e3165af` | 2026-11-23 | 语音模型默认走 hf-mirror 在线下载；模型安装器加固（占用/权限/半写入）；模型说明按实测校正；基于 r126（26.1126.0072） |
| r126 | 26.1126.0072 | tag `r126` → `feb837d` | 2026-11-23 | 修复同步翻译漏掉重新识别后的第一批字幕；基于 r125（26.1125.0071） |
| r125 | 26.1125.0071 | tag `r125` → `e02edda` | 2026-11-23 | 字幕识别时逐条同步翻译（边识别边翻译）；基于 r124（26.1124.0070） |
| r124 | 26.1124.0070 | tag `r124` → `0d35f83` | 2026-11-23 | 按新发布流程重建；基于 r123（26.1123.0069） |
| r123 | 26.1123.0069 | tag `r123` → `3eba4d6` | 2026-11-23 | 交互优化与工程化整理；基于 r122（26.1121.0068） |

### r135

- 完整包 `outputs/r135/DoNote-Windows-x64-r135.zip`
  `cffd5fd64486ccb42fd80161692008fc645e77bf317afe32f2ed127ca5c9c759`
- 增量包 `outputs/r135/DoNote-Update-26.1134.0080-to-r135.zip`
  `7110f472036e8da4a65adb9c2280e08efde7d3d565a449e61436d1e0fe6c588b`
- 发布记录 `outputs/r135/DoNote-r135-release.json`，检查项：`workspace`、`cloud-backup-transport`、`upgrade-and-rollback`、`package-checksums`。

### r134

- 完整包 `outputs/r134/DoNote-Windows-x64-r134.zip`
  `703880b1bf047ce75a0b13b1cb8eb6dbeb4649734a6cb1d8eae6172b06a45a9e`
- 增量包 `outputs/r134/DoNote-Update-26.1133.0079-to-r134.zip`
  `d13af26559bfa7b484ef7f017ff6fd59441c2b17afb78a2b2ba2a40b56c4a642`
- 发布记录 `outputs/r134/DoNote-r134-release.json`，检查项：`workspace`、`cloud-backup-transport`、`upgrade-and-rollback`、`package-checksums`。

### r133

- 完整包 `outputs/r133/DoNote-Windows-x64-r133.zip`
  `d36c3035fdc88d34d1747d2f46a79a1ec19f73c1c8f2bd31037bc711cf73486c`
- 增量包 `outputs/r133/DoNote-Update-26.1132.0078-to-r133.zip`
  `046314d2d813ebd943bb13b23c166de3cc4316d1a30bd27c1a271b0638f07f3a`
- 发布记录 `outputs/r133/DoNote-r133-release.json`，检查项：`workspace`、`cloud-backup-transport`、`upgrade-and-rollback`、`package-checksums`。

### r132

- 完整包 `outputs/r132/DoNote-Windows-x64-r132.zip`
  `c49cb53bec388fdf6a8639b64a0c2c8b86799727cde2677ad43b672e6d2ee26b`
- 增量包 `outputs/r132/DoNote-Update-26.1131.0077-to-r132.zip`
  `304b00e188837c6de207ac093f0658a790e06ca4ce2019286c8c3f6285c93fc3`
- 发布记录 `outputs/r132/DoNote-r132-release.json`，检查项：`workspace`、`upgrade-and-rollback`、`package-checksums`。

### r131

- 完整包 `outputs/r131/DoNote-Windows-x64-r131.zip`
  `46a1b9329a30dbb0b400ffe5eb8c03cb8ea7e4cdcf7ae5c14fa0f4464475296a`
- 增量包 `outputs/r131/DoNote-Update-26.1130.0076-to-r131.zip`
  `c3e4f2d050f53350212cfe3238a07b7f16afd3a5d20c63eecab0cd2fc16b97af`
- 发布记录 `outputs/r131/DoNote-r131-release.json`，检查项：`workspace`、`upgrade-and-rollback`、`package-checksums`。

### r130

- 完整包 `outputs/r130/DoNote-Windows-x64-r130.zip`
  `463412108e1d78cabd3e7cff43eeb7b705ded77640df1ef0178dd09aa8c39034`
- 增量包 `outputs/r130/DoNote-Update-26.1129.0075-to-r130.zip`
  `15f48c13722e4f5398838e64d31a49ec956b78600e075b8fe013e8bf56a8c5bf`
- 发布记录 `outputs/r130/DoNote-r130-release.json` 包含工作台回归、升级与回退、归档校验结果。

### r129

- 完整包 `outputs/r129/DoNote-Windows-x64-r129.zip`
  `ce08006ea7270bdf20622371a520d4ea9aa557ef3afc4c49d0cff1e23c28b0fd`
- 增量包 `outputs/r129/DoNote-Update-26.1128.0074-to-r129.zip`
  `50cfccccee15948e791782fecdb94efdd23d6676ac1e52ee6456455128f7be50`
- 发布记录 `outputs/r129/DoNote-r129-release.json`，检查项：`workspace`、`upgrade-and-rollback`、`package-checksums`。

### r128

- 完整包 `outputs/r128/DoNote-Windows-x64-r128.zip`
  `d35a4c6a6c66ea9e6ab5b7bc73e72c276df6b623043eb179f2f758c8d4a51ece`
- 增量包 `outputs/r128/DoNote-Update-26.1127.0073-to-r128.zip`
  `230c32355c92d0e372753ba4312faf66be25a2980eefe11bad31acb82de27dfe`
- 发布记录 `outputs/r128/DoNote-r128-release.json` 包含工作台、增量升级与回退、归档校验结果。

### r127

- 完整包 `outputs/r127/DoNote-Windows-x64-r127.zip`
  `9c7e47d8e35766ca33cdbd0c34b4d1de5069d589e09a88b82f34079e919f766f`
- 增量包 `outputs/r127/DoNote-Update-26.1126.0072-to-r127.zip`
  `94eefecdd095a0013f7b1a2311d36721ad0170af580a7eed66a31a8b5ec72e9b`
- 发布记录 `outputs/r127/DoNote-r127-release.json`，检查项：`workspace`、`upgrade-and-rollback`、`package-checksums`。

### r126

- 完整包 `outputs/r126/DoNote-Windows-x64-r126.zip`
  `7f9fb8c3beb872eaf8c28ff1ae45f7358d34b1825b65071c664cf1a04cf25f46`
- 增量包 `outputs/r126/DoNote-Update-26.1125.0071-to-r126.zip`
  `f36d17ba60c46c1bfc2518a1497369621ecfe8da5fc1adbc450176d04ff96761`
- 发布记录 `outputs/r126/DoNote-r126-release.json`，检查项：`workspace`、`upgrade-and-rollback`、`package-checksums`。

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

## 模型包

模型与程序分开发布，不放进 Git。当前已验证的模型包：

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `outputs/DoNote-Models-x64-2026-11-23.zip`（修复版安装器） | 9,252,198,099 | `ca4eb5cee6006923ef27a76074f3676116cfa7c40978b180258b90509f847cb6` |
| `outputs/DoNote-Models-x64-2026-11-14.zip`（原版） | 9,755,837,626 | `0ce9a023a1243fe115638ba0de4522ede603064297b6fd54e81321d705dc72a4` |
| `outputs/DoNote-Models-Installer-Fix-2026-11-23.zip`（只替换安装器的小修复包） | 3,364 | `f98647c300847bb75c6ce897f1c959cb853abe0d3e44b5066195652c42ab753f` |

模型包内容：4 个 faster-whisper（base、small、large-v3-turbo、large-v3）和 3 个 Qwen3 GGUF（4B-Q4_K_M、1.7B-Q4_K_M、0.6B-Q8_0）。已验证：ZIP 全量 CRC 通过，4 个 `model.bin` 与文档固定版本 SHA-256 一致，GGUF 文件头为 `GGUF`，应用可用 `models/asr/base` 实际完成识别。

没有模型包时，语音识别会在首次使用时从 `hf-mirror.com` 在线下载（`DONOTE_HF_ENDPOINT` 可覆盖，`official` 表示改用 huggingface.co），缓存在 `%USERPROFILE%\.cache\huggingface`；本地翻译 GGUF 需按 `本地离线翻译模型说明.md` 手动下载或安装模型包。

## 兼容边界

- WebView2 来源保留 `yams-one.example`，供现有 IndexedDB 访问。
- Windows 宿主与更新器继续共用 `YamsOne.Desktop` 互斥锁。
- 应用更新保护 `Data` 和模型文件。完整包只携带模型空目录占位文件。
- 桌面工作台从本地分文件加载代码、CSS 和 PDF worker。便携 HTML 使用独立的内联构建入口。
