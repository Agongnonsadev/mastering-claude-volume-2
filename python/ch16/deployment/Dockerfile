# Chapter 16: the image of the online Comptoir.
# Build from the python/ folder:  docker build -f ch16/deployment/Dockerfile -t comptoir-online .
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# The dependencies, pinned with their hashes (uv pip compile --generate-hashes): pip refuses
# a package whose hash has changed.
COPY ch16/deployment/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt && rm /tmp/requirements.txt

# The chapter 15 server, its online layer, and Awa's catalog.
COPY ch15/__init__.py ch15/comptoir_for_awa.py ch15/
COPY comptoir/data/delices_awa.json ch15/catalog.json
COPY ch16/__init__.py ch16/authorization.py ch16/online_server.py ch16/

# A user without privileges; the databases live in a volume, outside the image.
RUN useradd --create-home comptoir && mkdir /data && chown comptoir /data
USER comptoir
ENV COMPTOIR_SHOP=/data/shop.sqlite3 COMPTOIR_AUTHORIZATION=/data/authorization.sqlite3

EXPOSE 8016
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8016/health')"
# Behind Caddy, which terminates HTTPS: uvicorn trusts its X-Forwarded-* headers.
CMD ["uvicorn", "ch16.online_server:app", "--host", "0.0.0.0", "--port", "8016", "--proxy-headers", "--forwarded-allow-ips", "*"]
