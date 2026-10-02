FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/app.js ./app.js
COPY backend/config ./config
COPY backend/middleware ./middleware
COPY backend/models ./models
COPY backend/routes ./routes
COPY backend/services ./services
COPY backend/utils ./utils
COPY backend/workprocess ./workprocess

RUN mkdir -p uploads \
    && chown -R node:node /app/backend

USER node

EXPOSE 3000

CMD ["node", "app.js"]
