FROM node:22-alpine

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci --quiet

COPY . .
RUN npm run build

EXPOSE 3000

ENV PORT=3000
CMD ["npm", "start"]
