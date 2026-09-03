FROM node:20-alpine AS base
WORKDIR /app
ENV TZ=UTC

FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.build.json ./
RUN npx prisma generate && npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
