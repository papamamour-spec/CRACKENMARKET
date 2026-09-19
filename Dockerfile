# Étape 1 : dépendances + compilation (serveur TypeScript et interface Vite)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/* \
  && npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && mkdir -p server/node_modules

# Étape 2 : image d'exécution légère
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4000 DB_PATH=/data/crackenmarket.db
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/web/package.json web/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 4000
WORKDIR /app/server
CMD ["node", "dist/index.js"]
