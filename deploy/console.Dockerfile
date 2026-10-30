FROM node:22.21-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @riz/console...
RUN pnpm --filter @riz/console build
ENV NODE_ENV=production
CMD ["node", "apps/console/build"]
