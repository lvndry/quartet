FROM oven/bun:1.4-debian
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY src ./src
ENV QUARTET_HOME=/data
ENV QUARTET_HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "run", "src/main.ts"]
