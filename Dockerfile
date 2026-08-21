FROM mcr.microsoft.com/playwright:v1.54.2-jammy

WORKDIR /app

COPY package.json ./
RUN npm install

COPY monitor.js ./

CMD ["npm", "start"]
