# ---- build: full install (Vite and TypeScript are dev dependencies) ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY extensions/se-pixel/package.json extensions/se-pixel/package.json
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build && npm prune --omit=dev

# ---- run: production dependencies and the built app only ----
FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/prisma ./prisma
EXPOSE 3000
# Applies pending migrations, then starts the server.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
