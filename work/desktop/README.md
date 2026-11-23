# DoNote

双击 `DoNote.exe` 启动。首次使用、数据位置、更新方法与常见问题请阅读 `docs\开始使用.md`。

## 目录说明

| 目录 / 文件 | 用途 |
|---|---|
| `DoNote.exe` | 主程序 |
| `DoNoteUpdater.exe` | 更新助手，请勿单独移动 |
| `workspace` | 软件界面、内置页面和图片资源 |
| `video-runtime` | 离线语音识别与本地翻译运行环境 |
| `ai-bridge` | 本机 AI 接入服务 |
| `models` | 用户自行下载的语音识别和翻译模型 |
| `tools` | 重置等维护工具 |
| `docs` | 使用说明、模型说明和开源许可 |

## 常用入口

- [开始使用](docs/开始使用.md)
- [完整使用说明](docs/使用说明.md)
- [AI 接入指南](docs/AI接入指南.md)
- [语音模型下载说明](docs/视频模型下载说明.md)
- [视频字幕使用说明](docs/视频字幕使用说明.md)
- [本地翻译模型说明](docs/本地离线翻译模型说明.md)
- [模型目录说明](docs/模型目录说明.md)
- [MinerU 智能排版说明](docs/MinerU智能排版说明.md)

资料保存在 `Data`，或在 `data-location.txt` 指定的自定义目录中。更新程序不会删除资料和自行放入 `models` 的模型。

从旧版增量更新后，已知的根目录遗留文件会在首次启动时自动移入 `docs\legacy-from-update-*`，无需重新解压；`Data` 和 `models` 不会被移动。

