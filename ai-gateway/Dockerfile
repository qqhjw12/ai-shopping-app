FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev || true
COPY . .
EXPOSE 8080
CMD ["node", "src/server.js"]
