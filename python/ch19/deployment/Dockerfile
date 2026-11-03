# Chapter 19: the image of the Comptoir online (web chat and WhatsApp).
# Build from the python/ folder:  docker build -f ch19/deployment/Dockerfile -t comptoir-online .
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# The dependencies, pinned with their hashes (uv pip compile --generate-hashes): pip refuses a
# package whose hash has changed.
COPY ch19/deployment/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt && rm /tmp/requirements.txt

# The Comptoir's package, with its prompts, Awa's documents and the chat page. Neither the tests, nor the
# chapters' scripts, nor the data: .dockerignore keeps them out.
COPY comptoir/ comptoir/
# Chapter 21: the purge and the erasure on request, to run on the server
# (docker compose exec comptoir python -m ch18.data erase-number <number>).
COPY ch18/__init__.py ch18/data.py ch18/

# A user without privileges; the databases and the log live in a volume, outside the image.
# The API key and the WhatsApp secrets arrive through the environment (.env), never in the image.
RUN useradd --create-home comptoir && mkdir /data && chown comptoir /data
USER comptoir
ENV COMPTOIR_SHOP=/data/shop.sqlite3 COMPTOIR_CONVERSATIONS=/data/conversations.sqlite3 \
    COMPTOIR_BUDGET_DB=/data/budget.sqlite3 COMPTOIR_LOG=/data/log/calls.jsonl

EXPOSE 8019
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8019/health')"
# Behind Caddy, the only one to reach the container: uvicorn reads the customer's address in X-Forwarded-For.
CMD ["uvicorn", "comptoir.online:app", "--host", "0.0.0.0", "--port", "8019", "--proxy-headers", "--forwarded-allow-ips", "*"]
