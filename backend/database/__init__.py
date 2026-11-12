import os
import logging
from typing import Any, Optional
from .db import (
    Database,
    get_db_connection,
    init_db,
    compute_canonical_evidence,
    compute_face_commitment,
    compute_student_id,
    generate_invite_code
)

logger = logging.getLogger("attendchain.database")

def get_database(backend: Optional[str] = None) -> Any:
    """
    Factory to return either SQLite Database or MongoDatabase based on environment.
    If DATABASE_BACKEND=mongodb or MONGODB_URI is provided, returns MongoDatabase.
    Otherwise defaults to SQLite Database.
    """
    selected_backend = (backend or os.getenv("DATABASE_BACKEND", "")).strip().lower()
    mongo_uri = os.getenv("MONGODB_URI", "").strip()

    if selected_backend == "mongodb" or (not selected_backend and mongo_uri):
        try:
            from .mongo_db import MongoDatabase
            db_name = os.getenv("MONGODB_DB_NAME", "attendchain")
            logger.info(f"Connecting to MongoDB Atlas database '{db_name}'...")
            return MongoDatabase(uri=mongo_uri, db_name=db_name)
        except Exception as e:
            logger.error(f"Failed to connect to MongoDB Atlas: {e}. Falling back to SQLite.")

    # Default to SQLite
    db_path = os.getenv("DATABASE_PATH", "backend/data/attendchain.db")
    return Database(db_path=db_path)

__all__ = [
    "Database",
    "get_db_connection",
    "init_db",
    "get_database",
    "compute_canonical_evidence",
    "compute_face_commitment",
    "compute_student_id",
    "generate_invite_code"
]

