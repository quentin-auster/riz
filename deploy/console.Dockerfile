FROM node:22.21-alpine@sha256:0340fa682d72068edf603c305bfbc10e23219fb0e40df58d9ea4d6f33a9798bf
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @riz/console...
RUN pnpm --filter @riz/console build
ENV NODE_ENV=production
CMD ["node", "apps/console/build"]
