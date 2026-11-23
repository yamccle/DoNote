# DoNote 工作台与阅读界面

> L2 | 项目规则来自工作区 AGENTS.md。

- `notebook.html` 装配工作台，切换栏目后调用导航反馈。
- `record-editor.js` 连接打开、保存和关闭记录的操作。表单填充完成后开始暂存草稿。
- `rich-text.js` 同步正文纯文本，并通知草稿存储正文已经改变。
- `record-editor.css` 布置记录编辑器。标题、类型、正文和附件保留在主表单。
- `library.js` 在展开关联资料时生成候选列表。已选择的资料在收起后继续保留。
- `reliability.js` 暂存记录草稿、计划日期、归档文件夹和附件。
- `workspace-navigation.js` 同步栏目的选中状态、历史和快捷导航焦点。
- `workspace-dialogs.js` 收起与恢复浮窗，并保存其滚动位置。
- `design-system.css` 提供主题颜色、焦点和通用浮窗动画。
- `theme.css` 提供页面布局和控件样式，也定义收起浮窗时的遮罩。
- `pdf-tools.js` 定位阅读器工具菜单，处理工具菜单与侧栏标签的键盘焦点。
- `pdf-annotations.js` 和 `pdf-reflow.js` 为标注与排版菜单复用阅读器控制。
- `reader-toolbar.css` 和 `reader-panels.css` 限定工具菜单和抽屉动画。
- `video-subtitles.js` 同步播放位置和当前字幕，按用户操作定位字幕；「识别时同步翻译」开关让识别与离线翻译并行，逐条产出中文字幕。
- `video-subtitles.css` 提供字幕操作、任务进度和当前字幕的状态样式。
- `video-player-learning.js` 在学习控制栏保留字幕显示开关。

[PROTOCOL]: Update this header on change, then check AGENTS.md
