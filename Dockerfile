# ---------- Build ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- Nginx ----------
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Fallback SPA: sirve index.html para rutas desconocidas
RUN printf 'try_files $uri /index.html;\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
