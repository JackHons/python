FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice-impress poppler-utils fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY db ./db
COPY drizzle ./drizzle
COPY server ./server
COPY services/converter ./services/converter

USER node
CMD ["node", "--experimental-strip-types", "services/converter/worker.mjs"]
