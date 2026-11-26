# [INPUT]: 读取桥接服务的 Node.js 入口和本地模块。
# [OUTPUT]: 构建可启动 DoNote 桥接服务的容器。
# [POS]: 自建节点使用的容器入口。
# [PROTOCOL]: Update this header on change, then check AGENTS.md
FROM node:22-bookworm-slim
WORKDIR /app
COPY server.mjs mcp.mjs sync-v1.mjs account-v1.mjs openapi.json ./
RUN mkdir /data && chown node:node /data
USER node
ENV ANALOG_BIND=0.0.0.0 PORT=4318 ANALOG_DATA_DIR=/data
EXPOSE 4318
CMD ["node", "server.mjs"]
