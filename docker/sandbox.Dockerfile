FROM node:22-bookworm-slim

ARG PNPM_VERSION=10.15.1
ARG YARN_VERSION=4.9.2

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
  && corepack prepare "yarn@${YARN_VERSION}" --activate

ENV CI=1 \
    NO_COLOR=1 \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false

WORKDIR /workspace
USER node
CMD ["node", "--version"]
