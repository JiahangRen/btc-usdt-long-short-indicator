# 生产镜像：仅复制运行服务端所需的源码和静态资源。
# Production image: copy only the backend source and static assets required at runtime.
FROM node:22-alpine

WORKDIR /app
# Keep this list in sync with the relative imports in server.mjs and
# alert-worker.mjs. A missing module here makes the container exit at start-up
# and the deploy health check times out.
# 根文件必须落到 /app/ 根目录（package-lock.json 在 /app 下 npm ci 才能找到），
# shared 目录单独 COPY 以保留 /app/shared/ 目录名供运行时 import。
# 注意：多源 COPY 目标以 / 结尾会把所有源塞进该目录，绝不能把 app 文件与 shared 混在同一条 COPY。
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server.mjs ai-chat.mjs alert-store.mjs alert-worker.mjs notification.mjs ./
COPY --chown=node:node shared ./shared/
RUN npm ci --omit=dev
COPY --chown=node:node public ./public

# 容器运行时默认监听所有接口，供反向代理连接。
# The container listens on all interfaces by default so a reverse proxy can reach it.
ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
USER node
EXPOSE 8787

CMD ["node", "server.mjs"]
