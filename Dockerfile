# -------- Build (Astro) --------
FROM node:20-alpine AS build
WORKDIR /app

# Usa el lockfile si existe para builds reproducibles
COPY package*.json ./
RUN npm ci --quiet || npm install --no-audit --no-fund

# Copia el código y construye (Astro genera /dist)
COPY . .
# IMPORTANTE: si usas variables PUBLIC_ (p.ej. PUBLIC_API_BASE),
# configúralas en el entorno de CI/Deploy ANTES de este paso.
RUN npm run build

# -------- Runtime (Nginx) --------
FROM nginx:alpine
# Copia el artefacto estático
COPY --from=build /app/dist /usr/share/nginx/html

# Config Nginx con SPA fallback (index.html para rutas cliente)
RUN printf 'server {\n\
  listen 80;\n\
  server_name _;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  location / {\n\
    try_files $uri $uri/ /index.html;\n\
  }\n\
  # (Opcional) cache de assets estáticos
  location ~* \\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?)$ {\n\
    try_files $uri =404;\n\
    expires 1y;\n\
    add_header Cache-Control \"public, immutable\";\n\
  }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
