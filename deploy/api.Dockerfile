FROM node:22.21-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @riz/api...
RUN pnpm --filter @riz/api build
ENV NODE_ENV=production
CMD ["node", "apps/api/dist/index.js"]
