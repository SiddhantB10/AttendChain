# AttendChain API (Flask + OpenCV + MediaPipe) for Render or any Docker host.
# Debian 12 base: the graphics library package names below are stable there.
FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    APP_ENV=production \
    PORT=10000

# Shared libraries that OpenCV and MediaPipe load at import time
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 libegl1 libgles2 libglib2.0-0 libsm6 libice6 libx11-6 libxext6 libxcb1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so code changes don't reinstall them
COPY requirements-prod.txt .
RUN pip install -r requirements-prod.txt

# AI models (not stored in git). --strict fails the build if any download fails.
COPY scripts/download_models.py scripts/download_models.py
RUN python scripts/download_models.py --strict

COPY . .

# Run as an unprivileged user
RUN useradd --create-home --uid 10001 attendchain && chown -R attendchain /app
USER attendchain

EXPOSE 10000
CMD ["gunicorn", "-c", "gunicorn.conf.py", "backend.wsgi:app"]
