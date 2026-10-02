FROM node:24-alpine

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
COPY --chown=node:node views ./views
COPY --chown=node:node public ./public

EXPOSE 3000

ENV NODE_ENV=production

USER node

CMD ["node", "src/index"]
