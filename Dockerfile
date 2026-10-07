FROM node:20-slim
RUN apt-get update && apt-get install -y chromium fonts-freefont-ttf --no-install-recommends && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
CMD ["node", "bot.js"]
