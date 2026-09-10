# 生产镜像：仅复制运行服务端所需的源码和静态资源。
# Production image: copy only the backend source and static assets required at runtime.
FROM node:22-alpine

WORKDIR /app
# Keep this list in sync with the relative imports in server.mjs and
# alert-worker.mjs. A missing module here makes the container exit at start-up
# and the deploy health check times out.
COPY --chown=node:node package.json package-lock.json server.mjs ai-chat.mjs alert-store.mjs alert-worker.mjs ./
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
