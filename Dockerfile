# Norr service (apps/enclave). Built in CI and deployed to a Phala Cloud CVM by digest; see docs/DEPLOY-PHALA.md.
# Only the service, the MCP endpoint and the packages they import are installed (no dashboard, no tests, no dev tooling).
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# The pnpm version comes from "packageManager" in package.json, so the build and the repo agree.
RUN corepack enable

WORKDIR /app

# Dependencies first, from manifests and the lockfile alone, so this layer is cached until they change.
# Every workspace manifest is copied so --frozen-lockfile sees the same workspace the lockfile was made for.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/intents/package.json packages/intents/
COPY packages/shared/package.json packages/shared/
COPY apps/enclave/package.json apps/enclave/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --prod --filter "@norr/enclave..." --filter "@norr/mcp..."

COPY tsconfig.json ./
COPY packages packages
COPY apps/enclave apps/enclave
COPY apps/mcp apps/mcp

# The git commit the image was built from, shown on the dashboard's Verify screen.
ARG NORR_COMMIT=unknown
ENV NORR_COMMIT=$NORR_COMMIT \
    NODE_ENV=production \
    NORR_DATA_DIR=/data \
    PORT=8787

# State (ledger, counters, kill switch) lives on a volume, so it survives restarts and upgrades.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
WORKDIR /app/apps/enclave
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node_modules/.bin/tsx", "src/main.ts"]
