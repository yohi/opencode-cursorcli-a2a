FROM node:22-bookworm-slim

# Install development tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Set correct file permissions
RUN chown -R node:node /workspace

# Upgrade npm to latest
RUN npm install -g npm@latest

USER node

# Default shell
SHELL ["/bin/bash", "-c"]
