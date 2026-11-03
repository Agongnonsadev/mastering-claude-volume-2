# Chapter 19: the image of the Comptoir online, TypeScript version (web chat and WhatsApp).
# Build from the typescript/ folder (Awa's data, shared by the two versions, are read in
# python/comptoir):
#   docker build -f ch19/deployment/Dockerfile --build-context comptoir_python=../python/comptoir -t comptoir-online-ts .
FROM node:22.22.3-alpine

ENV NODE_ENV=production
WORKDIR /app/typescript

# The dependencies, pinned with their hashes (package-lock.json): npm ci refuses a package whose hash
# has changed. The TypeScript sources are run by tsx: nothing to compile.
COPY ch19/deployment/package.json ch19/deployment/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The shipped Comptoir, and the purge and the erasure on request of chapter 18, to run on the server
# (chapter 21: docker compose exec comptoir node --import tsx ch18/data.ts erase-number <number>).
COPY comptoir/*.ts comptoir/
COPY ch18/data.ts ch18/
# Awa's data, where the code looks for them (../python/comptoir): catalog, stock, knowledge base,
# prompts and chat page. Neither the customers' data nor the logs: they live in a volume.
COPY --from=comptoir_python data/delices_awa.json data/initial_stock.json /app/python/comptoir/data/
COPY --from=comptoir_python knowledge/ /app/python/comptoir/knowledge/
COPY --from=comptoir_python prompts/ /app/python/comptoir/prompts/
COPY --from=comptoir_python pages/ /app/python/comptoir/pages/

# A user without privileges; the databases and the log live in a volume, outside the image.
# The API key and the WhatsApp secrets arrive through the environment (.env), never in the image.
RUN adduser -D comptoir && mkdir /data && chown comptoir /data
USER comptoir
ENV COMPTOIR_SHOP=/data/shop.sqlite3 COMPTOIR_CONVERSATIONS=/data/conversations.sqlite3 \
    COMPTOIR_BUDGET_DB=/data/budget.sqlite3 COMPTOIR_LOG=/data/log/calls.jsonl

EXPOSE 8019
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8019/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Behind Caddy, the only one to reach the container: the server reads the customer's address in X-Forwarded-For.
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "comptoir/online.ts", "--host", "0.0.0.0", "--port", "8019", "--behind-a-proxy"]
