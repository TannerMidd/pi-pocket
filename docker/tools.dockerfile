# syntax=docker/dockerfile:1
#
# Pi Pocket with Python: the stock image (docker/Dockerfile) plus python3, uv,
# kubectl, Hugo with obsidian-export, and Obsidian with its CLI.
#
#   docker build -f docker/tools.dockerfile -t pi-pocket:tools .
#
# The stages before the tools below are the stock image's, line for line and in the
# same order, so this build makes that image first and this file only adds to it. They
# must stay identical: a line copied differently would make Docker build it again, and
# the tools would sit on a different base than pi-pocket:local.
#
# FROM stage AS name is a build-local reference; it does not make the image name that
# writes it a file name.

FROM node:24-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
# No native modules: a plain install is enough, and the runtime image stays small.
RUN npm ci --omit=dev --ignore-scripts=false \
    && npm cache clean --force

# The runtime image on common tools. It ends before the app source.
FROM node:24-bookworm-slim AS app

ARG CLOUDFLARED_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive

# The stock image has no python at all. Debian's python is enough for uv: uv reads
# the interpreter of a venv from its pyvenv.cfg, whatever version wrote it.
# `uv python install` cannot help, because UV_PYTHON_DOWNLOADS=0 is set for the
# session: a managed download lives in the container's writable layer and is gone
# on the next recreate.
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

# The stock image with Python. Nothing above changes for it, and nothing is copied
# again: this stage is the one that differs.
FROM app AS development

ARG UV_VERSION=0.13.5
ARG GLAB_VERSION=1.124.0
ARG HUGO_VERSION=0.169.0
ARG OBSIDIAN_EXPORT_VERSION=25.3.0
ARG OBSIDIAN_VERSION=1.14.5
ARG KUBECTL_VERSION=1.32.5

USER root

# GitLab's glab, for repository watches on a GitLab host (`repo-watches.ts`). It reads its
# token and host from GITLAB_TOKEN and GITLAB_HOST, so it needs no `glab auth login`.
# The binary is placed by architecture, as cloudflared is above.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) glab_arch=amd64 ;; \
        arm64) glab_arch=arm64 ;; \
        *) echo "glab has no release for $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /tmp/glab.tar.gz \
        "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/${GLAB_VERSION}/glab_${GLAB_VERSION}_linux_${glab_arch}.tar.gz"; \
    tar -xzf /tmp/glab.tar.gz -C /tmp bin/glab; \
    install -m 0755 /tmp/bin/glab /usr/local/bin/glab; \
    rm -rf /tmp/glab.tar.gz /tmp/bin; \
    GLAB_CONFIG_DIR=/tmp/glab-check /usr/local/bin/glab --version; \
    rm -rf /tmp/glab-check

# kubectl talks to a cluster that is elsewhere: it needs no cluster at build time, and
# `--version` only prints the client's. The version matches the cluster's (v1.32.5), so
# client and server speak the same API: kubectl may only be one minor ahead of or behind
# its server. A kubeconfig in ~/.kube is on the home bind mount, so `kubectl config
# use-context` and its logins survive a recreate. The binary is placed by architecture,
# as cloudflared is above; dl.k8s.io serves it without an archive.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) kubectl_arch=amd64 ;; \
        arm64) kubectl_arch=arm64 ;; \
        *) echo "kubectl has no release for $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /usr/local/bin/kubectl \
        "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${kubectl_arch}/kubectl"; \
    chmod 0755 /usr/local/bin/kubectl; \
    HOME=/tmp/kubectl-check /usr/local/bin/kubectl version --client; \
    rm -rf /tmp/kubectl-check

# Hugo builds the blog the LLMWiki vault holds (`blog/ponym.work/.site/build.sh`). It must
# be the extended build: the site's templates use image processing and `transform.ToMath`,
# and the standard build has neither. The archive holds one top-level file, so it is
# extracted straight into /usr/local/bin. The version is the one the project pins in its
# `.gitlab-ci.yml`.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) hugo_arch=amd64 ;; \
        arm64) hugo_arch=arm64 ;; \
        *) echo "Hugo has no release for $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /tmp/hugo.tar.gz \
        "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-${hugo_arch}.tar.gz"; \
    tar -xzf /tmp/hugo.tar.gz -C /usr/local/bin hugo; \
    rm -f /tmp/hugo.tar.gz; \
    hugo version | grep -q '+extended'

# obsidian-export is the step before Hugo: it rewrites the vault's Obsidian Markdown into
# the standard Markdown that Hugo renders (the first step of the same build.sh). It is a
# glibc binary, which is why the project's CI also uses Debian and not Alpine; this image
# is Debian too, so nothing more is needed. GitHub publishes it for x86_64 linux only, so
# an arm64 image gets Hugo and no export step, and `build.sh` names the tool it lacks.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) obsidian_export_arch=x86_64-unknown-linux-gnu ;; \
        *) echo "obsidian-export has no linux release for $arch: Hugo only" >&2; \
           obsidian_export_arch= ;; \
    esac; \
    if [ -n "$obsidian_export_arch" ]; then \
        curl -fsSL --retry 3 -o /tmp/obsidian-export.tar.xz \
            "https://github.com/zoni/obsidian-export/releases/download/v${OBSIDIAN_EXPORT_VERSION}/obsidian-export-${obsidian_export_arch}.tar.xz"; \
        tar -xJf /tmp/obsidian-export.tar.xz -C /tmp \
            "obsidian-export-${obsidian_export_arch}/obsidian-export"; \
        install -m 0755 "/tmp/obsidian-export-${obsidian_export_arch}/obsidian-export" \
            /usr/local/bin/obsidian-export; \
        rm -rf /tmp/obsidian-export.tar.xz "/tmp/obsidian-export-${obsidian_export_arch}"; \
        /usr/local/bin/obsidian-export --version; \
    fi

# The stock image has no python at all. Debian's python is enough for uv: uv reads
# the interpreter of a venv from its pyvenv.cfg, whatever version wrote it.
# `uv python install` cannot help, because UV_PYTHON_DOWNLOADS=0 is set for the
# session: a managed download lives in the container's writable layer and is gone
# on the next recreate.
#
# xvfb is for Obsidian below: the app is a window application, and the CLI talks to
# it; without a display it cannot start. The image's chromium already brought the
# other Electron libraries (GTK, NSS, GBM, ALSA).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        python3-dev \
        python3-venv \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

# The installer puts uv and uvx in /usr/local/bin and leaves nothing in ~/.bashrc,
# so the PATH below is the only one that matters.
#
# It also keeps a receipt in ~/.config/uv, and it runs as root here, so that folder is
# root's. The session runs as the host's uid: a ~/.config only root can write stops
# Chromium before it opens any page (it dies with SIGTRAP), which is why the folder is
# left writable by anyone, as UV_TOOL_BIN_DIR is below. The home folder itself is opened
# the same way, so that uid can write the cache Chromium and uv keep beside it (~/.cache).
RUN curl -LsSf https://astral.sh/uv/install.sh \
        | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 UV_VERSION="${UV_VERSION}" sh \
    && uv --version \
    && python3 --version \
    && mkdir -p /home/node/.config \
    && chmod -R a+rwX /home/node/.config \
    && chmod a+w /home/node

# uv tool install puts each tool's own entry points here. The image runs as root and
# the session runs as the host's uid, so the folder must be writable by anyone:
# `uv tool install ruff` in a session must work.
ENV UV_TOOL_BIN_DIR=/opt/uv-bin
RUN mkdir -p "${UV_TOOL_BIN_DIR}" && chmod 0777 "${UV_TOOL_BIN_DIR}"

# /opt/uv-bin comes before the rest of the image's PATH, which is kept as it is.
ENV PATH=/opt/uv-bin:${PATH}

# Obsidian's CLI is only a client: each command goes over a Unix socket to a running
# Obsidian app. The app is therefore installed too, and docker/obsidian (on PATH as
# `obsidian`) starts the app under Xvfb when no instance answers. The app is a large
# download (~130 MB, ~345 MB installed); it is in the tools image only.
#
# The amd64 build is the plain archive name; arm64 adds a suffix. The archive holds
# one top-level folder, so --strip-components=1 puts the app in /opt/obsidian.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) obsidian_arch= ;; \
        arm64) obsidian_arch=-arm64 ;; \
        *) echo "Obsidian has no release for $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /tmp/obsidian.tar.gz \
        "https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/obsidian-${OBSIDIAN_VERSION}${obsidian_arch}.tar.gz"; \
    mkdir -p /opt/obsidian; \
    tar -xzf /tmp/obsidian.tar.gz -C /opt/obsidian --strip-components=1; \
    rm -f /tmp/obsidian.tar.gz; \
    test -x /opt/obsidian/obsidian; \
    test -x /opt/obsidian/obsidian-cli

COPY docker/obsidian /usr/local/bin/obsidian
RUN chmod 0755 /usr/local/bin/obsidian

WORKDIR /workspace
