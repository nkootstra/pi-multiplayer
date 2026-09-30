# pi-multiplayer relay. Build from this directory:
#   docker build -t pi-multiplayer-relay .
#   docker run -p 8787:8787 -e RELAY_TOKENS="niels=$(docker run --rm pi-multiplayer-relay token)" pi-multiplayer-relay
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json ./
# Workspace-only dev dependencies aren't on npm; keep just the runtime ones.
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));delete p.devDependencies;fs.writeFileSync('package.json',JSON.stringify(p))" \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
ENTRYPOINT ["node", "src/main.ts"]
