FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
WORKDIR /usr/share/nginx/html
COPY --from=build /app/dist ./
COPY <<EOF /etc/nginx/conf.d/default.conf
server {
    listen 3000;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;
    
    location / {
        try_files \$uri \$uri/ /index.html;
    }
    
    location ~* \.(js|mjs)$ {
        add_header Content-Type application/javascript;
    }
    
    location ~* \.(css)$ {
        add_header Content-Type text/css;
    }
}
EOF
ENV PORT=3000
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]