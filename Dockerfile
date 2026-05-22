# Stage 1: Builder
FROM mirror.gcr.io/library/python:3.13-slim-bookworm AS builder

COPY --from=ghcr.io/astral-sh/uv:0.8.4 /uv /uvx /bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:$PATH"

ENV PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PIP_NO_CACHE_DIR=off \
    PIP_DISABLE_PIP_VERSION_CHECK=on \
    PIP_DEFAULT_TIMEOUT=100 \
    PYSETUP_SETUPTOOLS_SCM_PRETEND_VERSION_FOR_PYPI="0.0.0" \
    VENV_PATH="/app/.venv" \
    UV_FROZEN=1

WORKDIR /app

# Copy only dependency files first for better layer caching
COPY pyproject.toml uv.lock* README.md ./

# Install dependencies without workspace members
RUN uv sync --no-dev --no-install-workspace

# Now copy the actual source code
COPY getgather /app/getgather
COPY tests /app/tests

# Install the workspace package
RUN uv sync --no-dev

# Stage 2: Final image
FROM mirror.gcr.io/library/python:3.13-slim-bookworm

RUN apt-get update && apt-get install -y \
    iproute2 \
    sudo \
    ca-certificates \
    iptables \
    podman \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/.venv /opt/venv
COPY --from=builder /app/getgather /app/getgather
COPY --from=builder /app/tests /app/tests

ENV PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    USER=getgather \
    PATH="/opt/venv/bin:$PATH"

ARG PORT=23456
ENV PORT=${PORT}

# port for FastAPI server
EXPOSE ${PORT}

RUN useradd -m -s /bin/bash getgather && \
    chown -R getgather:getgather /app && \
    usermod -aG sudo getgather && \
    echo 'getgather ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER getgather

ENTRYPOINT ["sh", "-c", "exec python -m uvicorn getgather.main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips='*'"]
