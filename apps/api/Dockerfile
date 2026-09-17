FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
COPY apps/api/package*.json apps/api/
COPY apps/web/package*.json apps/web/

RUN npm ci

COPY . .

RUN npm run prisma:generate --workspace apps/api \
  && npm run build:api

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy --schema apps/api/prisma/schema.prisma && npm run prisma:seed --workspace apps/api && node apps/api/dist/src/main.js"]
