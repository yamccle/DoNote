# DoNote AI 桥接与多端同步网关

> L2 | Parent: /AGENTS.md

Member list
- `server.mjs`: HTTP 接入主服务，提供工作台快照管理、助手令牌鉴权（撤销即彻底清除不留冗余记录）、异步任务队列与 CORS 安全边界。
- `mcp.mjs`: Model Context Protocol (MCP) 协议层，向已授权外部 AI 助手暴露文献检索、记录读写与字幕翻译工具。
- `sync-v1.mjs`: 多端在线同步协议层 (`/api/sync/v1/*`)，支持 SHA-256 内容寻址去重块存储、PDF/PPT 批注级细粒度合并、SSE 实时变更广播 (`/events`) 与零信任端到端加密密文信封。
- `openapi.json`: REST 接口规范定义。
- `adapter.py`: Python 侧本地与远程调用适配器示例。
- `AI接入指南.md`: 面向用户与外部助手的接入与权限说明文档。
- `Dockerfile` / `.dockerignore`: 容器化自建同步与桥接节点镜像定义。
- `Start-Local.cmd`: Windows 本机独立启动入口脚本。
- `stage-desktop.ps1`: 桌面发布构建脚本，校验 Node.js 运行时并将网关脚本打包入 `ai-bridge/`。

[PROTOCOL]: Update this header on change, then check AGENTS.md
