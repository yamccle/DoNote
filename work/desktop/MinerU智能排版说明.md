# MinerU 智能排版

DoNote 的 PDF「阅读模式 → 智能排版」使用本地 MinerU 4.2.1 解析 PDF 结构。它会在本地识别标题、段落、表格、公式和阅读顺序，再显示为连续阅读版式。

## 阅读模式

- 「整页对照翻译」通过 PDFMathTranslate 重建当前 PDF 页的文字与版面。左侧是原页，右侧是译页，两侧共用页码、缩放和滚动。此模式从 PDF 文本层提取待译文字。
- 「智能排版」重建阅读顺序和文档结构。「排版翻译」沿用同一结构，将原文和译文按段对应。宽屏左右排列，窄屏上下排列。图片、表格和独立公式保留原结构，正文和图注可翻译。
- 排版翻译使用「翻译服务」中的设置。整页对照可在工具栏选择内置的「快速离线」或「本地大模型」。本地大模型的目录为 `models\translation`。

## 默认模式

当前默认使用 MinerU `flash` 档位：

- 带可用文本层的 PDF 可直接解析。排版页先显示从 PDF 文本层生成的预览，随后更新为 MinerU 的结构。
- PDF 在本机临时目录中交给 MinerU。解析采用逐页请求，打开同一份 PDF 期间复用已加载的 MinerU 进程。
- 成功生成的页面结构按 PDF 内容、页码和解析档位缓存。解析失败时保留 PDF 文本层预览。

## 复杂扫描件

`flash` 在遇到扫描页或文本层质量不足时会尝试 OCR，首次使用可能需要下载模型并初始化。DoNote 的阅读界面使用 `flash`。MinerU 的 `basic`、`standard` 和 `advanced` 档位需要额外的模型和运行环境。

MinerU 模型权重由上游运行时按需获取，默认从 ModelScope 下载到资料目录的 `MinerU\models`。如果 DoNote 安装目录下存在 `models\mineru`，程序会将它用作模型目录。可以按 [MinerU 的模型说明](https://opendatalab.github.io/MinerU/usage/model_source/) 准备可离线使用的模型。

PDF 预览页为空白且没有 PDF 页面对象或注释时，会直接显示该页，无需启动 OCR。

## 许可

MinerU 使用 MinerU Open Source License（基于 Apache-2.0 并附加条款）。完整许可见 `docs\licenses\MINERU-LICENSE.md`。DoNote 在阅读模式菜单和本文档中明确标注使用了 MinerU。

