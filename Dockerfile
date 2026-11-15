# Не нужен для обычного запуска на своём компьютере (npm start). Образ не проверялся.
# В контейнере приложение должно слушать все интерфейсы; порт публикуйте только на localhost:
#   docker run -p 127.0.0.1:3000:3000 -v tender-data:/data -e OLLAMA_URL=http://host.docker.internal:11434 tender-checklist
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 HOST=0.0.0.0
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
