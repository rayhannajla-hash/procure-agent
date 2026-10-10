FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/server.mjs"]
