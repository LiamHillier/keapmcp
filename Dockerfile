# Build stage: compile TypeScript and generate the endpoint catalogue.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY scripts ./scripts
COPY spec ./spec
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage: only what dist/http.js needs. The catalogue is read from
# src/catalog.json at runtime, so it ships alongside dist.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    KEAP_MCP_HOST=0.0.0.0 \
    KEAP_MCP_PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/catalog.json ./src/catalog.json
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/http.js"]
