# syntax=docker/dockerfile:1
# Production image for apps/web: a static Vite build served by unprivileged nginx, which also
# reverse-proxies the API (same origin → no CORS, cookies stay same-site).
#   docker build -f apps/web/Dockerfile -t derivdesk-web .
ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/api/package.json apps/api/
COPY apps/admin-api/package.json apps/admin-api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
RUN npm ci --ignore-scripts
COPY packages/shared-types packages/shared-types
COPY apps/web apps/web
# Empty = same origin (the nginx below proxies /api). Only set this to talk to a DIFFERENT origin.
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build --workspace apps/web

FROM ${NGINX_IMAGE} AS runtime
COPY infra/nginx/web.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/nginx-health || exit 1
