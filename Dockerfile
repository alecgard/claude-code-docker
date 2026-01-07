FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*

RUN npm i -g @anthropic-ai/claude-code

# Create mountpoints so --read-only works
RUN mkdir -p /workspace /workspace-ro /claude-home && \
    chown -R node:node /workspace /workspace-ro /claude-home

USER node
WORKDIR /workspace

CMD ["/bin/bash"]