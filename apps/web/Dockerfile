FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
COPY apps/api/package*.json apps/api/
COPY apps/web/package*.json apps/web/

RUN npm ci

COPY . .

ARG VITE_API_URL=http://localhost:3000/api/v1
ARG VITE_WS_URL=ws://localhost:3000/ws
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
# "sede" = web local del Gravix de sede (solo Equipos, Piloto Gravix y Usuarios).
ARG VITE_GRAVIX_MODO=central
ENV VITE_GRAVIX_MODO=$VITE_GRAVIX_MODO

RUN npm run build:web

FROM nginx:1.27-alpine

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
