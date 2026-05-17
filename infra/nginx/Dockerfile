FROM node:22-alpine AS frontend-builder
WORKDIR /app

COPY package*.json ./
COPY apps/frontend/package.json ./apps/frontend/package.json
RUN npm ci

COPY . .
RUN npm run -w apps/frontend build

FROM nginx:1.27-alpine AS runner

COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=frontend-builder /app/apps/frontend/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
