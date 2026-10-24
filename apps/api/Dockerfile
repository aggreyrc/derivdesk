# syntax=docker/dockerfile:1
# Production image for apps/api. Build context is the REPO ROOT:
#   docker build -f apps/api/Dockerfile -t derivdesk-api .
# Debian slim (not alpine) on purpose: Prisma's query engine targets glibc + OpenSSL, and the same
# base is used to generate and to run, so the engine that is built is the engine that loads.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# ---- build: full install, generate the Prisma client, compile TypeScript -----------------------
FROM base AS build
# Manifests first so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/api/package.json apps/api/
COPY apps/admin-api/package.json apps/admin-api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
RUN npm ci --ignore-scripts
COPY packages packages
RUN npm run generate --workspace packages/db
COPY apps/api apps/api
RUN npm run build --workspace apps/api

# ---- runtime: production dependencies only, no compiler, no tests, no source ---------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/api/package.json apps/api/
COPY apps/admin-api/package.json apps/admin-api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
# `npm ci --workspace X --omit=dev` still installs X's OWN devDependencies (tsx, esbuild, ...), so strip
# them from this stage's copy of the manifests first. The build stage above is unaffected.
RUN node -e 'const fs=require("fs");for(const p of ["apps/api/package.json","packages/db/package.json"]){const j=JSON.parse(fs.readFileSync(p));delete j.devDependencies;fs.writeFileSync(p,JSON.stringify(j,null,2))}' \
    && npm ci --omit=dev --ignore-scripts --workspace apps/api && npm cache clean --force
COPY --from=build /repo/packages/db/generated packages/db/generated
COPY --from=build /repo/apps/api/dist apps/api/dist
USER node
WORKDIR /repo/apps/api
ENV PORT=4000
EXPOSE 4000
# Liveness only (the process is up and the event loop answers). Readiness — database reachable,
# bot-runner role — is /ready, which orchestrators/load balancers should use.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
