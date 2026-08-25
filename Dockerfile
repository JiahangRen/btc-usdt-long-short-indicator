FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node public ./public

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
USER node
EXPOSE 8787

CMD ["node", "server.mjs"]
