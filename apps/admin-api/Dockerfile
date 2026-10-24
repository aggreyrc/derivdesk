# syntax=docker/dockerfile:1
# Production image for apps/admin-api (the ADMIN backend — deploy it on the internal network only).
#   docker build -f apps/admin-api/Dockerfile -t derivdesk-admin-api .
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

FROM base AS build
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
COPY apps/admin-api apps/admin-api
RUN npm run build --workspace apps/admin-api

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/api/package.json apps/api/
COPY apps/admin-api/package.json apps/admin-api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
# NOT stripped of devDependencies (unlike apps/api): the operator scripts below run through `tsx`,
# which is a devDependency here. Dropping it would break `create-admin` / `enroll-totp` / `rotate-totp-key`.
RUN npm ci --omit=dev --ignore-scripts --workspace apps/admin-api && npm cache clean --force
COPY --from=build /repo/packages/db/generated packages/db/generated
COPY --from=build /repo/apps/admin-api/dist apps/admin-api/dist
# The operator scripts (create-admin, enroll-totp) run through tsx from source, so the image keeps
# them, plus the two modules enroll-totp imports. They are run by an operator with
# `docker compose exec admin-api npm run enroll-totp -- --email ...`, never exposed over HTTP.
COPY --from=build /repo/apps/admin-api/scripts apps/admin-api/scripts
COPY --from=build /repo/apps/admin-api/src/lib apps/admin-api/src/lib
COPY --from=build /repo/apps/admin-api/tsconfig.json /repo/apps/admin-api/tsconfig.scripts.json apps/admin-api/
USER node
WORKDIR /repo/apps/admin-api
ENV PORT=4100
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
