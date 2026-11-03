# Chapter 16: the image of the online Comptoir, TypeScript version.
# Build from the typescript/ folder (Awa's catalog is read in python/comptoir/data):
#   docker build -f ch16/deployment/Dockerfile --build-context data=../python/comptoir/data -t comptoir-online-ts .
FROM node:22.22.3-alpine

ENV NODE_ENV=production
WORKDIR /app

# The dependencies, pinned with their hashes (package-lock.json): npm ci refuses a package whose hash has
# changed. The TypeScript sources are run by tsx: nothing to compile.
COPY ch16/deployment/package.json ch16/deployment/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The chapter 15 server, its online layer, the shared code they depend on, and Awa's catalog.
COPY comptoir/rounding.ts comptoir/dates.ts comptoir/launch.ts comptoir/python.ts comptoir/
COPY ch15/comptoir_for_awa.ts ch15/schemas.ts ch15/
COPY ch16/authorization.ts ch16/schemas.ts ch16/online_server.ts ch16/
COPY --from=data delices_awa.json ch15/catalog.json

# A user without privileges; the databases live in a volume, outside the image.
RUN adduser -D comptoir && mkdir /data && chown comptoir /data
USER comptoir
ENV COMPTOIR_SHOP=/data/shop.sqlite3 COMPTOIR_AUTHORIZATION=/data/authorization.sqlite3

EXPOSE 8016
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8016/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Behind Caddy, which terminates HTTPS: the server trusts its X-Forwarded-For header (one proxy).
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "ch16/online_server.ts", "--host", "0.0.0.0", "--port", "8016", "--behind-a-proxy"]
