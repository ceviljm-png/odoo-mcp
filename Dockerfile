FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Registro de auditoría de escrituras: montar un volumen de Easypanel en /data
RUN mkdir -p /data && chown node:node /data
ENV AUDIT_LOG_PATH=/data/audit.jsonl
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1
USER node
CMD ["node", "dist/index.js"]
