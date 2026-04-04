#!/usr/bin/env python3
"""Database migration script for NUERAL-TRADER-5."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.config import Config
from storage.db_handler import DBHandler


async def migrate() -> None:
    config = Config.get()
    db = DBHandler(config)
    print("Connecting to database…")
    await db.connect()
    if db._pool is None:
        print("ERROR: Could not connect to database. Check POSTGRES_* environment variables.")
        sys.exit(1)
    print("Migration complete — all tables and hypertables created.")
    await db.close()


if __name__ == "__main__":
    asyncio.run(migrate())
