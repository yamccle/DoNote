# DoNote

DoNote 是本地优先的跨学科知识精读、文献管理与课题研究工作台。桌面端使用 C# WinForms、WebView2 和本地工作台。

- `work/desktop/` 提供 Windows 宿主、文件接口、GitHub 在线自动更新、本地更新器和离线服务入口。
- `work/analog-notes/public/` 提供工作台、篮板式拖拽分拣入库、后台任务中心、十张成就殿宇卡牌、编辑器、PDF、PPT 和视频界面。
- `work/analog-notes/scripts/` 构建桌面工作台和便携 HTML。
- `work/ai-bridge/` 提供外部助手 MCP 接口、本机授权与 `/api/sync/v1` 多端内容寻址增量同步服务。
- `work/video-runtime-build/` 只纳入两个已修改的翻译源码目录。运行依赖按发布锁定文件读取。
- `tools/release.ps1` 从 Git 提交构建并核验发布包。
- `tools/tests/` 使用隔离资料和合成附件检查关键流程。
- `docs/releases/` 记录恢复基线、构建方法和运行依赖。
- `docs/HANDOFF.md` 是换手说明：当前版本与标签、本机工具路径、构建/发布/测试命令和硬性约定。

保持 WebView2 存储来源与更新互斥锁兼容。变更前要有迁移和升级验证。
编译产物、旧阶段目录、安装资料和模型留在 Git 之外。
