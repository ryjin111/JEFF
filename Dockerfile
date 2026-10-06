FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
RUN npm ci --omit=dev --no-audit --no-fund
COPY src/ ./src/
COPY public/ ./public/
ENV NODE_ENV=production JEFF_BIND=0.0.0.0 JEFF_DATA_ROOT=/data
EXPOSE 8788
CMD ["node", "src/server.mjs"]
