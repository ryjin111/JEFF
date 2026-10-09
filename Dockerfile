FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
RUN npm ci --omit=dev --no-audit --no-fund
COPY src/ ./src/
COPY public/ ./public/
ENV NODE_ENV=production JEFF_BIND=0.0.0.0 JEFF_DATA_ROOT=/data
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
