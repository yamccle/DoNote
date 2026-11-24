# DoNote 工作台与阅读界面

> L2 | 项目规则来自工作区 AGENTS.md。

- `notebook.html` 装配主页、栏目工具栏与记录编辑器。
- `workspace-home.js` 从保存的附件位置和计划生成主页首屏。
- `reader-session.js` 从附件检查点恢复阅读位置。多附件资料使用该附件的阅读完成状态。
- `workspace-home.css` 布置继续阅读、近期计划和主页组件。
- `workspace-toolbar.js` 重用搜索、栏目筛选和菜单动作，按当前栏目排列。
- `workspace-toolbar.css` 布置栏目的主操作和响应式菜单。
- `workspace-layout.css` 布置标题、主页侧栏及记录列表。
- `categories.js` 为导航和编辑器同步当前工作台的栏目与类型名称。
- `record-editor.js` 按当前栏目选择新建路径。编辑器切换类型时保留已填写的正文与计划日期。
- `plans.js` 提供计划日期和周期字段，切换类型时由编辑器决定是否初始化日期。
- `rich-text.js` 同步正文纯文本，并通知草稿存储正文已经改变。
- `record-editor.css` 布置类型选择器和记录编辑器。附件与关联资料集中于正文前。
- `library.js` 在展开关联资料时生成候选列表。已选择的资料在收起后继续保留。
- `reliability.js` 暂存记录草稿、计划日期、归档文件夹和附件。
- `workspace-navigation.js` 同步栏目的选中状态、历史和快捷导航焦点。
- `workspace-context-menu.js` 提供工作台菜单和带版本校验的记录移动。
- `record-folders.js` 验证目录树，提供路径和栏目筛选。
- `library-folders.js` 显示资料库当前层、路径和每张卡片的菜单入口。
- `folder-context-menu.js` 复用工作台菜单，将目录操作传给文件夹窗口。
- `folder-manager.js` 为各栏目提供目录树搜索和目标选择。删除与回收站在同一事务提交。
- `folder-management.css` 布置目录卡片、路径、搜索和操作窗口。
- `library-organization.js` 将多选资料交给同一移动窗口，并保留批量标签和阅读清单。
- `trash.js` 为文件夹和单条记录暂存回收站变化。
- `workspace-dialogs.js` 按浮窗实例恢复当前草稿，并保留滚动位置。
- `design-system.css` 提供主题颜色、焦点和通用浮窗动画。
- `theme.css` 提供页面布局、浮窗遮罩和整页编辑器的主题颜色。
- `pdf-tools.js` 定位阅读器工具菜单，处理工具菜单与侧栏标签的键盘焦点。
- `pdf-annotations.js` 和 `pdf-reflow.js` 为标注与排版菜单复用阅读器控制。
- `reader-toolbar.css` 和 `reader-panels.css` 限定工具菜单和抽屉动画。
- `web-reader.js` 阅读已保存网页。选中正文或已有标注可保存为研究笔记，笔记经 `webSource` 打开原文并定位摘录。
- `video-subtitles.js` 同步播放位置和当前字幕，按用户操作定位字幕；「识别时同步翻译」开关让识别与离线翻译并行，逐条产出中文字幕。
- `video-subtitles.css` 提供字幕操作、任务进度和当前字幕的状态样式。
- `video-player-learning.js` 在学习控制栏保留字幕显示开关。

[PROTOCOL]: Update this header on change, then check AGENTS.md
