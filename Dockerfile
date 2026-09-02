FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next compiles server route modules during build. Runtime secrets are supplied
# to the final image; these values are placeholders for build-time validation.
ENV OPENAI_API_KEY=build-placeholder \
    MONGODB_URI=mongodb://127.0.0.1:27017 \
    MONGODB_DATABASE=agency_os_build \
    AGENCY_AUTH_MODE=bootstrap \
    AGENCY_BOOTSTRAP_OWNER_TOKEN=agency-os-build-placeholder-token-0000000000000000 \
    AGENCY_TRANSACTIONS_REQUIRED=true
RUN npm run build

FROM node:22-alpine AS worker-base
WORKDIR /app
ENV NODE_ENV=production \
    AGENCY_WORKSPACE_ROOT=/var/lib/agency-os/workspaces \
    AGENCY_ARTIFACT_ROOT=/var/lib/agency-os/artifacts
RUN apk add --no-cache git \
  && corepack enable \
  && mkdir -p /var/lib/agency-os/workspaces /var/lib/agency-os/artifacts \
  && chown -R node:node /var/lib/agency-os
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src ./src
USER node
CMD ["npm", "run", "runner"]

# Trusted-host provider retained for development and dedicated single-tenant
# runner hosts. This image includes the Docker client and may use a socket mount.
FROM worker-base AS worker
USER root
RUN apk add --no-cache docker-cli
USER node

# M7 production runner. Repository validation is delegated to the signed
# remote-http sandbox API; this image has no Docker client or socket dependency.
FROM worker-base AS remote-worker

FROM node:22-alpine AS web
WORKDIR /app
ENV NODE_ENV=production \
    AGENCY_WORKSPACE_ROOT=/var/lib/agency-os/workspaces \
    AGENCY_ARTIFACT_ROOT=/var/lib/agency-os/artifacts
RUN corepack enable \
  && mkdir -p /var/lib/agency-os/artifacts \
  && chown -R node:node /var/lib/agency-os
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
USER node
EXPOSE 3000
CMD ["npm", "start"]
