FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY idl ./idl
USER node
ENV NODE_ENV=production
CMD ["node","src/server.js"]
