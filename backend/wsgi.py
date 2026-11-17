"""
Production entry point for gunicorn:

    gunicorn -c gunicorn.conf.py backend.wsgi:app
"""
from backend.app import create_app

app = create_app()
