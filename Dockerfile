FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY --from=builder --chown=node:node /app /app
RUN mkdir -p /data/db /data/storage /data/exports /data/backups \
    && chown -R node:node /data

USER node
EXPOSE 3000

CMD ["sh", "-c", "exec /app/node_modules/.bin/wrangler dev --config dist/server/wrangler.json --ip 0.0.0.0 --port 3000 --var PYTHON_RUNNER_TOKEN:$RUNNER_SERVICE_TOKEN"]
