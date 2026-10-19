FROM node:24-trixie-slim

# QEMU runs the browser VMs; only the system emulator for this architecture.
# zstd compresses the state of suspended VMs. The Docker CLI builds the VM
# image, through the host's Docker socket, and fetches registry tokens over TLS.
RUN apt-get update \
    && case "$(dpkg --print-architecture)" in arm64) qemu=qemu-system-arm ;; *) qemu=qemu-system-x86 ;; esac \
    && apt-get install -y --no-install-recommends "$qemu" qemu-utils zstd docker-cli docker-buildx ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
COPY --chown=node:node views ./views
COPY --chown=node:node public ./public
COPY --chown=node:node vm ./vm

# VM_DATA_DIR: the image builds, the snapshot that the server saves at
# startup, and the VMs. Mount it, writable, to keep it all across restarts,
# suspended browsers included.
RUN mkdir -p /app/.data/vm && chown -R node:node /app/.data

EXPOSE 3000

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV HOME=/home/node
# The container may run as any user, who may not own HOME.
ENV DOCKER_CONFIG=/tmp/docker

USER node

CMD ["node", "src/index"]
