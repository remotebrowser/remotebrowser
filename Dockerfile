FROM node:24-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends podman docker-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
COPY --chown=node:node views ./views
COPY --chown=node:node public ./public

EXPOSE 3000

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV HOME=/home/node

USER node

CMD ["node", "src/index"]
