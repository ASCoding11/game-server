# For hosts that run containers (Fly.io, Render, Railway...). A plain VPS uses deploy/setup.sh instead.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV PORT=2567
EXPOSE 2567
CMD ["node", "src/main.js"]
