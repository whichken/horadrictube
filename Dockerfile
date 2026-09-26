FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM debian:trixie-slim
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libvulkan1 mesa-vulkan-drivers tini ca-certificates passwd \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 bun
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY LICENSE ./LICENSE
RUN mkdir -p /config /data /transcode && chown bun:bun /config /data /transcode
USER bun
ENV NODE_ENV=production PORT=5000 CONFIG_DIR=/config DATA_DIR=/data TRANSCODE_DIR=/transcode \
    TONEMAP_BACKEND=cpu TONEMAP_THREADS=2 XDG_CACHE_HOME=/tmp/horadrictube-cache
RUN MESA_SHADER_CACHE_DISABLE=true bun dist/index.js --check-media
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD bun -e "fetch('http://127.0.0.1:'+(Bun.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "dist/index.js"]
