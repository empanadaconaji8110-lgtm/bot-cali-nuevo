FROM ghcr.io/puppeteer/puppeteer:22
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
CMD ["node", "bot.js"]
