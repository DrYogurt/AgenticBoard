FROM node:20-alpine

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci --quiet

COPY . .
RUN npm run build

ENV TERM=xterm-256color
CMD ["npm", "start"]
