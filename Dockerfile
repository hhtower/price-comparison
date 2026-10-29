FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/catalog/package.json ./packages/catalog/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/catalog/package.json ./packages/catalog/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/catalog/dist ./packages/catalog/dist
RUN chown -R node:node /app
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
STOPSIGNAL SIGTERM
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server/main.js"]
