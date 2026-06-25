# Pinned to a content digest for reproducible builds (tag: node:24-bookworm-slim).
# Refresh: docker pull node:24-bookworm-slim && docker image inspect node:24-bookworm-slim --format '{{join .RepoDigests "\n"}}'
FROM node:24-bookworm-slim@sha256:c2d5ade763cacfb03fe9cb8e8af5d1be5041ff331921fa26a9b231ca3a4f780a
WORKDIR /app
COPY server.js ./server.js
EXPOSE 9090
HEALTHCHECK --interval=5s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9090)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]