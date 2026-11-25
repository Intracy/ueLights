# ---------- Build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

# ---------- Laufzeit ----------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    WEB_DIR=/app/web/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
CMD ["node", "server/dist/index.js"]
