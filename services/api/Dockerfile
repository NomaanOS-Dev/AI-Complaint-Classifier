FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY services/api/package.json services/api/package.json
RUN npm install
COPY services/api ./services/api
WORKDIR /app/services/api
RUN npm run build
COPY services/api/src/migrations ./migrations
EXPOSE 4000
CMD ["npm", "start"]
