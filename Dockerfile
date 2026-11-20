FROM node:22.22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 DATABASE_PATH=/app/data/planner.sqlite
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
RUN mkdir /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8080
CMD ["node", "src/index.js"]
