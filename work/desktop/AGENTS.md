# DoNote Windows 桌面端

> L2 | 项目规则来自工作区 AGENTS.md。

## 构建与更新

- `build.ps1` 构建桌面宿主和工作台，并写入发布清单。
- `stage-runtime.ps1` 按运行依赖锁定文件核验旧包，只提取发布所需依赖。
- `make-update-patch.ps1` 比较两个完整清单，生成已验证的增量 ZIP。
- `UpdatePackage.cs` 校验文件路径、版本及内容。普通应用包拒绝模型文件。

## 开场动画

- `Program.cs` 读取当前资料目录的开场设置。WebView2 开始播放后，宿主隐藏标题栏。播放退出、页面切换或超时后，宿主恢复标题栏。
- `startup-splash.js` 在画布上绘制约 2.5 秒的运笔和光迹。它通过 `startup-splash-enter` 和 `startup-splash-exit` 通知宿主。
- `startup-splash.css` 保持画布宽高比，并使用工作台主题色铺满窗口。
- `startup-wordmark.js` 提供由签名照描摹的矢量轮廓。
- `build.ps1` 将开场脚本、样式和画面放入安装包的 `workspace` 目录。
- `开始使用.md` 记录开场设置、键盘操作和减少动态效果的行为。

## 设置浮层

- `desktop-settings.js` 将设置浮层挂到当前窗口。子菜单在可见控件之间移动焦点。退出设置时恢复原控件焦点。
- `desktop-settings.css` 使用工作台主题和动画变量。系统减少动态效果时，设置浮层直接显示。

[PROTOCOL]: Update this header on change, then check AGENTS.md
