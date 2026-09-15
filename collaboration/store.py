"""One transactional owner for board state, membership and invitations.

The database lives only in this Kanban app's numeric storage directory. The
constructor requires that directory explicitly; there is no global/default DB.
Every mutation commits its complete JSON record atomically, including CAS
version and membership changes. No lock or transaction spans network I/O.
"""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3


class Store:
    def __init__(self, root):
        root = Path(root)
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / 'collaboration.sqlite3'
        self.db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('PRAGMA busy_timeout=10000')
        self.db.execute('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id))')

    def close(self):
        self.db.close()

    @contextmanager
    def transaction(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield self
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def get(self, kind, key):
        row = self.db.execute('SELECT body FROM records WHERE kind=? AND id=?', (kind,key)).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, kind, key, value):
        self.db.execute('INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body', (kind,key,json.dumps(value,separators=(',',':'),allow_nan=False)))

    def delete(self, kind, key):
        self.db.execute('DELETE FROM records WHERE kind=? AND id=?', (kind,key))

    def list(self, kind):
        return [json.loads(row[0]) for row in self.db.execute('SELECT body FROM records WHERE kind=? ORDER BY id', (kind,))]
