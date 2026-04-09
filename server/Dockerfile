# Multi-stage Dockerfile for HypeReels API server
# Stage "dev"   — hot-reload with tsx watch (used by docker-compose)
# Stage "build" — compiles TypeScript
# Stage "prod"  — minimal production image

FROM node:20-alpine AS base
WORKDIR /app
COPY package.json ./
RUN npm install --frozen-lockfile

# ─── Development (hot-reload) ─────────────────────────────────────────────────
FROM base AS dev
ENV NODE_ENV=development
COPY tsconfig.json ./
COPY src ./src
EXPOSE 3001
CMD ["npx", "tsx", "watch", "src/index.ts"]

# ─── Build ────────────────────────────────────────────────────────────────────
FROM base AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Production ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --frozen-lockfile --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3001
CMD ["node", "dist/index.js"]
