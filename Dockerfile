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

# Config Nginx: server + SPA fallback
RUN printf 'server {\n\
  listen 80;\n\
  server_name _;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  # Fallback SPA: sirve index.html para rutas no encontradas\n\
  location / {\n\
    try_files $uri $uri/ /index.html;\n\
  }\n\
  # (Opcional) cache largo para assets estáticos\n\
  location ~* \\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?)$ {\n\
    try_files $uri =404;\n\
    expires 1y;\n\
    add_header Cache-Control \"public, immutable\";\n\
  }\n\
}\n' > /etc/nginx/conf.d/default.conf


EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
