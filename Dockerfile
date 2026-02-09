FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
