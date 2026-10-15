FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
# Optional extra CA certificates (e.g. a corporate TLS-inspection root) — any
# *.crt in ./certs is trusted during the build. The folder may be empty.
COPY certs/ /usr/local/share/ca-certificates/extra/
RUN update-ca-certificates >/dev/null 2>&1 || true
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt
COPY app ./app
EXPOSE 8000
# Runs as root only because it needs the Docker socket; the port is published on
# 127.0.0.1 only (see docker-compose.live.yml).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
