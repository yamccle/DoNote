FROM node:22-bookworm-slim
WORKDIR /app
COPY server.mjs mcp.mjs sync-v1.mjs openapi.json ./
RUN mkdir /data && chown node:node /data
USER node
ENV ANALOG_BIND=0.0.0.0 PORT=4318 ANALOG_DATA_DIR=/data
EXPOSE 4318
CMD ["node", "server.mjs"]
