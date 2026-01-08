FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG GO_VERSION=1.21.13
ARG NODE_MAJOR=22

# ---- OS deps ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    openssh-client \
    bash \
    tar \
    gzip \
    unzip \
 && rm -rf /var/lib/apt/lists/*

# ---- Node.js 22 ----
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/*

# ---- Go 1.21 ----
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) goarch="amd64" ;; \
      arm64) goarch="arm64" ;; \
      *) echo "Unsupported architecture: ${arch}"; exit 1 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" -o /tmp/go.tgz; \
    rm -rf /usr/local/go; \
    tar -C /usr/local -xzf /tmp/go.tgz; \
    rm -f /tmp/go.tgz

ENV PATH="/usr/local/go/bin:${PATH}"

# ---- Claude Code CLI ----
RUN npm i -g @anthropic-ai/claude-code

# ---- CRE CLI (official installer) ----
RUN curl -fsSL https://cre.chain.link/install.sh | bash \
 && mv /root/.cre/bin/cre /usr/local/bin/cre \
 && chmod +x /usr/local/bin/cre \
 && rm -rf /root/.cre \
 && cre version

# ---- Non-root user (no fixed UID; avoids UID 1000 collision) ----
RUN useradd -m -s /bin/bash node

# ---- Create mountpoints so --read-only works ----
RUN mkdir -p /workspace /workspace-ro /claude-home \
 && chown -R node:node /workspace /workspace-ro /claude-home

USER node
WORKDIR /workspace

CMD ["/bin/bash"]