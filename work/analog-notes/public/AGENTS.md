# DoNote 工作台与阅读界面

> L2 | 项目规则来自工作区 AGENTS.md。

- `notebook.html` 装配主页、栏目工具栏与记录编辑器。
- `workspace-home.js` 从保存的附件位置和计划生成主页首屏。
- `reader-session.js` 和 `reader-tabs.js` 从附件检查点恢复 PDF / PPT / 视频阅读位置，并支持在论文 PDF 与讲义 PPT 多标签之间原地切换。
- `workspace-home.css` 布置继续阅读、近期计划和主页组件。
- `workspace-toolbar.js` 重用搜索、栏目筛选和菜单动作，按当前栏目排列。
- `workspace-toolbar.css` 布置栏目的主操作和响应式菜单。
- `workspace-layout.css` 布置标题、左侧导航栏、统计条、主页侧栏、全站记录卡片及资料库列表。
- `categories.js` 为导航和编辑器同步当前工作台的栏目与类型名称。
- `record-editor.js` 按当前栏目选择新建路径。编辑器切换类型时保留已填写的正文与计划日期。
- `plans.js` 提供计划日期和周期字段，切换类型时由编辑器决定是否初始化日期。
- `rich-text.js` 同步正文纯文本，并通知草稿存储正文已经改变。
- `record-editor.css` 布置类型选择器和记录编辑器。附件与关联资料集中于正文前。
- `library.js` 在展开关联资料时生成候选列表。已选择的资料在收起后继续保留。
- `reliability.js` 暂存记录草稿、计划日期、归档文件夹和附件。
- `notebook-v2.js` 存取工作台记录与附件，并为本机备份和云端快照生成同一恢复清单。
- `large-backup.js` 读取用户选择的快照目录，并调用统一恢复流程。
- `workspace-navigation.js` 同步栏目的选中状态、历史和快捷导航焦点。
- `workspace-context-menu.js` 提供工作台菜单和带版本校验的记录移动。
- `record-folders.js` 验证目录树，提供路径和栏目筛选。
- `library-folders.js` 显示资料库当前层、路径和每张卡片的菜单入口。
- `folder-context-menu.js` 复用工作台菜单，将目录操作传给文件夹窗口。
- `folder-manager.js` 为各栏目提供目录树搜索和目标选择。子文件夹默认折叠，搜索时仍列出匹配项。删除与回收站在同一事务提交。
- `folder-management.css` 布置目录卡片、路径、搜索和操作窗口。
- `library-organization.js` 将多选资料交给同一移动窗口，并保留批量标签和阅读清单。
- `trash.js` 为文件夹和单条记录暂存回收站变化。
- `workspace-dialogs.js` 按浮窗实例恢复当前草稿，并保留滚动位置。
- `design-system.css` 提供主题颜色、焦点和通用浮窗动画。
- `theme.css` 提供页面布局、浮窗遮罩和整页编辑器的主题颜色。
- `pdf-tools.js` 定位阅读器工具菜单，处理工具菜单与侧栏标签的键盘焦点。选中文字或框选图表后，可新建研究笔记，或追加到设计问题与仿真记录。
- `pdf-research-notes.js` 把摘录与原文片段写进目标记录的 `pdfSource` / `pdfEvidence`。详情「引用资料」展示摘录预览并按页码和选区回跳原 PDF。
- `pdf-backlinks.js` 汇总当前 PDF 被哪些记录引用，在页面右上角显示「被引用 N」角标并在侧栏「引用」页签提供反向打开与选区定位。
- `pdf-ocr.js` 离线识别扫描页框选区域，将识别文本交给翻译/摘录侧栏并写入 `pdf-search.js` 持久化检索索引。
- `pdf-translation.js` 以「原文 → 电路术语胶囊 → 译文」无嵌套双栏衔接选区/识字翻译、复制译文、保存批注、存为研究笔记与追加到记录；手动校对文字时保留原页面与选区坐标。
- `circuit-glossary.js` 匹配模拟电路专业术语，在翻译双栏中段展示命中胶囊并支持一键插入译文或自定义术语库。
- `translate-lang.js` 管理翻译源语言与目标语言偏好，支持副栏一键互换语向。
- `pdf-annotations.js`、`pdf-annotation-export.js` 和 `pdf-reflow.js` 提供紧凑批注卡片、页签计数、仅当前页过滤、渐进式批注展开、圆点换色、闪烁回跳与排版重流控制。
- `reader-ai.js` 提供工程精读快捷提问、SSE 流式回答、Markdown + KaTeX 公式防转义排版、可点击页码胶囊回跳与沉淀笔记。
- `reader-toolbar.css` 和 `reader-panels.css` 统一布局工具菜单、右侧四页签面板、双栏翻译卡、紧凑批注卡与公式级 AI 问答界面。
- `presentation-preview.js` 和 `presentation-preview.css` 提供 PPT / PPTX 资料库级工作台：左侧幻灯片胶片导航、网格总览、沉浸全屏放映、原片讲义自动提取、逐页批注防抖保存、一键沉淀研究笔记或追加记录，以及资料库首页封面缩略图生成。
- `web-capture.js`、`web-library.js` 和 `web-reader.js` 衔接单进程并发网页抓取、极速纯正文模式与离线网页阅读；选中正文或已有标注可保存为研究笔记并经 `webSource` 回跳定位。
- `video-subtitles.js` 同步播放位置和当前字幕，按用户操作定位字幕；「识别时同步翻译」开关让识别与离线翻译并行，逐条产出中文字幕。
- `video-subtitles.css` 提供字幕操作、任务进度和当前字幕的状态样式。
- `video-player-learning.js` 在学习控制栏保留字幕显示开关。

[PROTOCOL]: Update this header on change, then check AGENTS.md
