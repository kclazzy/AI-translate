"""Content-addressed image assets and the SQLite result cache."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any


class AssetStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, asset_id: str) -> Path:
        if not asset_id.isalnum() or len(asset_id) != 64:
            raise ValueError("bad asset id")
        return self.root / asset_id[:2] / f"{asset_id}.png"

    def put(self, data: bytes) -> str:
        asset_id = hashlib.sha256(data).hexdigest()
        path = self._path(asset_id)
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
        return asset_id

    def get(self, asset_id: str) -> bytes | None:
        try:
            path = self._path(asset_id)
        except ValueError:
            return None
        return path.read_bytes() if path.exists() else None

    def exists(self, asset_id: str) -> bool:
        try:
            return self._path(asset_id).exists()
        except ValueError:
            return False


class ResultCache:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self.conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS result_cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL, created REAL NOT NULL, last_hit REAL NOT NULL)"
        )
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL)"
        )
        self.conn.commit()

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.conn.execute("SELECT payload FROM result_cache WHERE key = ?", (key,)).fetchone()
            if not row:
                return None
            self.conn.execute("UPDATE result_cache SET last_hit = ? WHERE key = ?", (time.time(), key))
            self.conn.commit()
        return json.loads(row[0])

    def put(self, key: str, payload: dict[str, Any]) -> None:
        now = time.time()
        with self._lock:
            self.conn.execute(
                "INSERT OR REPLACE INTO result_cache (key, payload, created, last_hit) VALUES (?, ?, ?, ?)",
                (key, json.dumps(payload, ensure_ascii=False), now, now),
            )
            self.conn.commit()

    def prune(self, days: int) -> int:
        cutoff = time.time() - days * 86400
        with self._lock:
            cur = self.conn.execute("DELETE FROM result_cache WHERE last_hit < ?", (cutoff,))
            self.conn.commit()
            return cur.rowcount

    def record_usage(self, usages: list[dict[str, Any]]) -> None:
        if not usages:
            return
        with self._lock:
            self.conn.executemany(
                "INSERT INTO usage_events (at, provider, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)",
                [(time.time(), u.get("provider"), u.get("model"), u.get("inputTokens", 0), u.get("outputTokens", 0), u.get("costUsd", 0.0)) for u in usages],
            )
            self.conn.commit()

    def usage_totals(self) -> dict[str, Any]:
        with self._lock:
            row = self.conn.execute("SELECT COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cost_usd),0) FROM usage_events").fetchone()
        return {"calls": row[0], "inputTokens": row[1], "outputTokens": row[2], "costUsd": row[3]}
