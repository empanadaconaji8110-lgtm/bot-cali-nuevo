FROM ghcr.io/puppeteer/puppeteer:22.11.0
USER root
WORKDIR /app
COPY package.json./
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
RUN npm install
COPY..
CMD ["node", "bot.js"]
