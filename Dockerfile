# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/relay/package.json apps/relay/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --ignore-scripts

COPY apps/relay apps/relay
COPY packages/protocol packages/protocol
RUN npm run build --workspace @glossa/protocol \
  && npm run build --workspace @glossa/relay

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/relay/package.json apps/relay/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --omit=dev --ignore-scripts \
  --workspace @glossa/protocol \
  --workspace @glossa/relay

COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/apps/relay/dist apps/relay/dist
COPY --from=build /app/apps/relay/sql apps/relay/sql

USER node
EXPOSE 39100
CMD ["npm", "run", "start", "--workspace", "@glossa/relay"]
