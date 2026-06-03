FROM node:20-alpine
RUN apk add --no-cache git docker-cli docker-cli-compose docker-cli-buildx
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 5000
CMD ["node", "index.js"]
