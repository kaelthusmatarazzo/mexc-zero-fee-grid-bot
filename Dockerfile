FROM node:20-slim

WORKDIR /app
COPY package.json .
COPY server.js .
COPY demo_test.js .

EXPOSE 8000
CMD ["node", "server.js"]
