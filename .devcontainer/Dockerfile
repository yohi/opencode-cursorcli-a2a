FROM node:22-bookworm-slim

# Install development tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1000 node || true \
    && useradd --uid 1000 --gid node --shell /bin/bash --create-home node || true

WORKDIR /workspace

# Set correct file permissions
RUN chown -R node:node /workspace

USER node

# Upgrade npm to latest
RUN npm install -g npm@latest

# Default shell
SHELL ["/bin/bash", "-c"]
