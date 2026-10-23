# syntax=docker/dockerfile:1
#
# Pi Pocket in a container. The app runs straight from its source (Node strips the
# TypeScript), so this image only installs the runtime packages and the tools Pi's
# built-in extensions use: git, GitHub's gh, ripgrep, fd, Chromium, and cloudflared.
#
# Build from the repository root:
#   podman build -f docker/Dockerfile -t pi-pocket .
#   docker build -f docker/Dockerfile -t pi-pocket .

FROM node:24-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
# No native modules: a plain install is enough, and the runtime image stays small.
RUN npm ci --omit=dev --ignore-scripts=false \
    && npm cache clean --force

FROM node:24-bookworm-slim

ARG CLOUDFLARED_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        fd-find \
        fontconfig \
        fonts-dejavu-core \
        fonts-liberation \
        gh \
        git \
        jq \
        less \
        openssh-client \
        procps \
        ripgrep \
        tini \
        xz-utils \
        chromium \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Cloudflare Tunnel is optional, but the launcher needs the binary for
# `--access cloudflare` and cannot download it without a terminal.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) cloudflared_arch=amd64 ;; \
        arm64) cloudflared_arch=arm64 ;; \
        *) echo "cloudflared has no release for $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /usr/local/bin/cloudflared \
        "https://github.com/cloudflare/cloudflared/releases/${CLOUDFLARED_VERSION}/download/cloudflared-linux-${cloudflared_arch}"; \
    chmod 0755 /usr/local/bin/cloudflared; \
    /usr/local/bin/cloudflared --version

# The app: source, web app, docs it tells Pi about, and types for drop-ins.
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY bin ./bin
COPY src ./src
COPY web ./web
COPY docs ./docs
COPY types ./types
COPY test ./test
COPY README.md AGENTS.md SECURITY.md LICENSE ./

# Pi's folder (sign-ins, settings, skills, sessions) and Pi Pocket's data folder
# are bind mounts in docker-compose.yml. These are the fallbacks for `docker run`.
ENV HOME=/home/node \
    PI_POCKET_DIR=/data \
    PI_POCKET_ACCESS=lan \
    PI_POCKET_PORT=8787 \
    PI_POCKET_BROWSER=/usr/bin/chromium \
    PI_POCKET_BROWSER_ARGS="--no-sandbox --disable-dev-shm-usage" \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

RUN mkdir -p /data /workspace /home/node/.pi \
    && chmod 0700 /data

WORKDIR /workspace

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PI_POCKET_PORT||8787)+'/style.css').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# tini reaps Chromium's children and forwards signals to the launcher. The
# entrypoint clears Chromium's stale profile locks before the app starts.
COPY docker/entrypoint.sh /usr/local/bin/pi-pocket-entrypoint
RUN chmod 0755 /usr/local/bin/pi-pocket-entrypoint

# No arguments by default: an --access argument would override PI_POCKET_ACCESS, and
# the base image's CMD (node) is not one of the launcher's options.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pi-pocket-entrypoint"]
CMD []
