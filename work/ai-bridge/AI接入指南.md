# Yam's ONE AI 接入指南

AI 管理给每个助手发放独立令牌，可分别授权读取快照、新增记录、更新记录、上传附件和读取接入服务中的附件。令牌绑定到创建时选择的工作台。在「AI 管理」可以查看同步结果并撤销凭证。

## 验证 Grok Bot

1. 按下方说明启动本机服务，或连接已经部署的云端服务。已有旧版服务的用户可以迁移原有令牌和待同步任务。
2. 在 Yam's ONE「AI 管理」填写服务根地址并连接，创建专用助手，勾选「读取快照」和「新增记录」。点击「验证 MCP 接入」。工具列表里应看到 `workspace`、`create_record`、`task_status`。
3. **Grok Bot 云端或 Grok 网页版**使用可达的 `https://你的域名/mcp`。在连接器设置中添加 MCP 地址，用助手令牌配置 `Authorization: Bearer <助手令牌>`。如果界面只提供 OAuth，使用支持自定义请求头的 Grok API 调用。 [Grok Bot 应用连接](https://docs.x.ai/grok-bot/computer-and-apps) · [Grok 自定义连接器](https://docs.x.ai/grok/connectors)
4. **Grok Bot 在本机执行命令**时，可以用配套 `adapter.py` 访问 `http://127.0.0.1:4318`。这要求 Grok Bot 已启用本机命令能力，并在执行时获得相应授权。其云电脑有自己的 `127.0.0.1`。 [Grok Bot 本机与云端说明](https://docs.x.ai/grok-bot/computer-and-apps#your-local-computer-is-separate)
5. 在测试工作台让 Grok 调用 `workspace`，再调用 `create_record` 新增一条测试记录，记下返回的任务 ID。回到 Yam's ONE 点「立即同步」。任务由 `pending` 变成 `applied`、且栏目中出现记录，才表示写入完成。

「验证 MCP 接入」检查服务和工具权限。要验证云端是否可达，需要从 Grok 使用公网 HTTPS 地址实际调用。同步时保持 Yam's ONE 打开并连接服务。编辑记录期间同步会暂停。

使用 xAI Responses API 时，可以把以下对象放入 `tools` 数组。用安全的环境变量提供两种不同凭证，调用 API 使用 xAI API 密钥，连接 Yam's ONE 使用助手令牌。 [xAI Remote MCP 文档](https://docs.x.ai/developers/tools/remote-mcp)

```python
import os

tool = {
    "type": "mcp",
    "server_url": os.environ["YAMS_ONE_URL"].rstrip("/") + "/mcp",
    "server_label": "yams_one",
    "headers": {
        "Authorization": "Bearer " + os.environ["YAMS_ONE_AGENT_TOKEN"]
    },
    "allowed_tools": ["workspace", "create_record", "task_status"],
}
```

## 在这台 Windows 电脑运行

桌面版在「AI 管理」点击「启动并连接本机服务」。运行环境随桌面版提供，关闭 Yam's ONE 会停止由它启动的服务。需要手动运行时，双击程序目录中 `ai-bridge` 里的 `Start-Local.cmd` 并保持服务窗口打开，然后在「AI 管理」导入 `当前资料目录下的 AiBridge/connection.json`，点击「连接并发布快照」。

单独下载的网页版接入包使用 Node.js 22 或更新版本。双击接入包中的 `Start-Local.cmd` 并保持服务窗口打开，再从「AI 管理」导入接入服务目录下的 `runtime/connection.json`。

输入助手名称，例如 Grok Bot，勾选所需权限并创建凭证。把助手令牌交给对应的 bot 运行程序，连接文件内的管理令牌由你自己保管。本机助手默认访问 `http://127.0.0.1:4318`。助手提交后，可以点击「立即同步」，也可开启自动同步。

从旧版接入包迁移时，先停止旧服务，关闭桌面版，再将旧 `runtime` 目录中的内容复制到尚无数据的 `当前资料目录下的 AiBridge`。首次启动桌面服务时会更新连接文件，并继续使用原有令牌和待同步任务。

## 给云端 bot 使用

将同一服务部署到你控制的服务器，并为服务配置 HTTPS 域名。桌面版或离线网页版在「AI 管理」中填写该 HTTPS 地址和管理令牌。云端 bot 使用同一个 HTTPS 地址和它自己的助手令牌。本机地址只供本机程序访问。此接入包提供部署文件，公开地址需由你配置。

以下是 Docker 部署示例。将 `ANALOG_ADMIN_TOKEN` 写入服务器的环境变量或密钥管理。至少使用 24 个字符，建议随机生成，例如运行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`。反向代理把公网 HTTPS 请求转发给服务器本机的 4318 端口。若需要上传大附件，请同时配置代理的请求体大小和超时。

```sh
docker build -t yams-one-bridge .
docker volume create yams-one-bridge-data
docker run -d --name yams-one-bridge --restart unless-stopped \
  -p 127.0.0.1:4318:4318 -e ANALOG_ADMIN_TOKEN \
  -v yams-one-bridge-data:/data yams-one-bridge
```

也可直接运行 `node server.mjs`。将 `ANALOG_DATA_DIR` 指向持久目录，并根据部署环境设置 `ANALOG_BIND` 和 `PORT`。桌面版和离线网页版可直接使用默认允许来源。另有自托管网页时，通过 `ANALOG_ALLOWED_ORIGINS=null,https://你的网页域名` 添加该来源。对同一数据目录运行一个服务实例，备份其状态及文件目录。

## 在支持自定义 HTTP 的 bot 中注册工具

将 `openapi.json` 交给支持导入 OpenAPI 的 bot 运行程序，或将 `adapter.py` 中的 `workspace`、`records`、`submit`、`task_status` 和 `upload` 注册为工具函数。配置环境变量 `YAMS_ONE_URL` 与 `YAMS_ONE_AGENT_TOKEN`，并让 Grok bot 等助手在调用工具时使用它们。也可以直接按同一接口发送 HTTP 请求。每次请求使用 `Authorization: Bearer <助手令牌>`。这些工具需要由 bot 的运行程序接入。

```python
from adapter import YamsOne

client = YamsOne()
task = client.submit(
    "create",
    {"type": "issue", "title": "环路稳定性复查", "body": "复核相位裕度与测试条件。"},
    "loop-stability-20261104-01",
)
print(client.task_status(task["id"])["state"])
```

| 操作 | 接口与权限 |
| --- | --- |
| 获取栏目和可用状态 | `GET /v1/workspace`，需要 `records:read` |
| 搜索快照 | `GET /v1/records?q=关键词`，需要 `records:read` |
| 新增记录 | `POST /v1/tasks`，`operation=create`，需要 `records:create` |
| 更新记录 | `POST /v1/tasks`，`operation=update`，需要 `records:update` |
| 查询提交结果 | `GET /v1/tasks/{id}`，提交该任务的助手可查询 |
| 上传附件 | `POST /v1/files`，需要 `files:write`。请求体为原始文件字节，`X-File-Name` 为 URL 编码文件名，单件上限 100 MiB。在任务的 `record.fileIds` 中引用返回的 ID |
| 下载服务附件 | `GET /v1/files/{id}`，需要 `files:read` |

## 更新、重试与同步

- 更新时提供 `record.id` 和最新快照中的 `record.baseUpdatedAt`（对应 `updatedAt`）。可传 `appendBody` 追加内容，也可修改标题、作者、标签、状态或追加附件。版本发生变化时，重新读取快照并核对内容后再提交。
- 每项操作使用独立的 `requestId`。网络重试时保留原请求编号及内容。
- `pending` 表示服务已保存任务。Yam's ONE 打开并连接服务后，才会将任务同步到本机工作台。 `applied` 表示已写入，`rejected` 表示未写入，原因随状态返回。
- 默认快照包含标题、作者、标签、状态和附件清单。开启「快照包含正文」后，服务才会收到笔记正文。原有附件字节由工作台保存。发给云端服务的资料应符合你的工作资料共享权限。
- 「AI 管理」中的助手令牌负责写入和查阅工作台。PDF 阅读器里的「AI 助手」使用其自己的模型设置来回答当前文档的问题。



## 计划、整理和完整工作台权限

- 在 AI 管理中选择「完整工作台权限」，核对范围后创建助手。该按钮会选中读取、创建、更新、删除以及附件权限，并勾选发布正文、近期 PDF 摘录和自动同步。只有授权工作台的数据可用。
- `create_record` 创建计划时用 `type: "plan"`，填 `planStart` 和 `planEnd`，格式为 YYYY-MM-DD。用 `relatedResources` 传入通过 `search_records` 查到的资料 ID。
- `update_record` 可用 `appendBody` 追加总结，用 `tags` 更新标签，用 `folderPath: ["模拟", "ADC"]` 重新分类。路径中的目录会按需创建。空数组表示移到未归档。
- `upload_text_file` 用于最多 256 KiB 的文本或代码，随后把返回的 `id` 放入 `fileIds`。其他附件使用 REST 上传。上传与写入使用各自稳定的 requestId。
- `delete_record` 需要删除权限，以及最新的记录 ID 和 `baseUpdatedAt`。删除成功后，已删除资料的关联和清单条目也会清理。
- 读取使用最近发布的快照。勾选 PDF 摘录后，快照最多提取近期 30 份、单个不超过 24 MiB 的 PDF，各取前 20 页的可选中文本。扫描件与附件原文件不会自动上传。
# 文献信息自动搜索与保存

MCP 工具 search_literature_metadata 接受 title 或 doi，与软件文献信息窗口使用相同的 Crossref 数据源，返回 title、author、materialType、literature 等候选字段。REST 对应 GET /v1/literature/search?title=标题 或 ?doi=DOI；Python 对应 literature_candidates(title=..., doi=...)。

先用 search_records 读取记录与 updatedAt，再搜索并核对候选的标题、作者、年份及资料类型。确认后调用 update_record，传入 requestId 和 record: {id, baseUpdatedAt, title, author, literature}。literature 支持 doi、publication、year、abstract、translatedTitle、translatedAbstract，按字段合并。省略的旧字段会保留；传空字符串可以清除错误字段。最后轮询 task_status，只有 applied 才可报告保存成功。pending 仅表示排队，需要软件打开并连接同步。

不能确认的候选应留空或请用户核对，尤其课程讲义、会议合集不得套用其中单篇文章 DOI。原文件不会因保存元数据而改写。升级后助手客户端需刷新工具列表或重连。

