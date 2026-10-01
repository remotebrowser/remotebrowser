FROM node:24-alpine

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

EXPOSE 3000

ENV NODE_ENV=production

USER node

CMD ["node", "src/index"]
