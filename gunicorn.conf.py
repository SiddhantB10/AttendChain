"""
Gunicorn settings for the AttendChain API (used by the Docker image / Render).

One worker process on purpose: the app keeps per-process state (login rate limiting,
the blockchain nonce lock, background session-closing threads) and loads ~350 MB of AI
models. Threads give concurrency for I/O (Hedera RPC, MongoDB) inside that one process.
"""
import os

bind = f"0.0.0.0:{os.getenv('PORT', '10000')}"
workers = 1
threads = int(os.getenv("GUNICORN_THREADS", "4"))
worker_class = "gthread"
# Face analysis of 30 frames plus a Hedera transaction can take several seconds,
# longer on a cold start, so allow generous request time.
timeout = int(os.getenv("GUNICORN_TIMEOUT", "120"))
graceful_timeout = 30
keepalive = 5
accesslog = "-"
errorlog = "-"
loglevel = os.getenv("LOG_LEVEL", "info")
# Trust X-Forwarded-* from the platform proxy (Render / Vercel rewrite)
forwarded_allow_ips = "*"
