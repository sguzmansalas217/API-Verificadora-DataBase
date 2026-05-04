# ✅ Imagen ligera de Node
FROM node:18-alpine

# ✅ Instalar datos de zona horaria
RUN apk add --no-cache tzdata

# ✅ Fijar zona horaria
ENV TZ=America/Mexico_City

# ✅ Directorio dentro del contenedor
WORKDIR /app

# ✅ Copiar package.json y package-lock.json primero (mejor cache)
COPY package*.json ./

# ✅ Instalar dependencias de producción
RUN npm install --production

# ✅ Copiar el resto del código
COPY . .

# ✅ Exponer el puerto que usa Express
EXPOSE 3000

# ✅ Comando para iniciar tu backend
CMD ["node", "server.js"]
