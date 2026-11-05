FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data
EXPOSE 8090
CMD ["npm", "run", "start"]
