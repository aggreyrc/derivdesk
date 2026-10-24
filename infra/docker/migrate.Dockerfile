# syntax=docker/dockerfile:1
# One-shot migration image. Build context: REPO ROOT.
#   docker build -f infra/docker/migrate.Dockerfile -t derivdesk-migrate .
# Holds the Prisma CLI, the migrations and the role grants — and is the ONLY image that ever sees the
# owner database credential. The long-running API images contain none of this.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/api/package.json apps/api/
COPY apps/admin-api/package.json apps/admin-api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
# Only the db package's dependencies (this includes the prisma CLI, a devDependency there).
RUN npm ci --ignore-scripts --workspace packages/db && npm cache clean --force
# Fetch the Prisma engines now, so the container needs no outbound network when it runs.
RUN npx prisma --version
COPY packages/db/prisma packages/db/prisma
COPY infra/db-init infra/db-init
COPY scripts/migrate-entrypoint.sh scripts/migrate-entrypoint.sh
RUN chmod +x scripts/migrate-entrypoint.sh && chown -R node:node /repo
USER node
ENTRYPOINT ["scripts/migrate-entrypoint.sh"]
