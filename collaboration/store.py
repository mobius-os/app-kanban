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

    # Keys of per-board records start with '<board id>/', so one board's records
    # are a contiguous key range that SQLite reads from the primary-key index
    # instead of decoding every record of that kind.

    def scan(self, kind, prefix, *, after=None):
        """(key, value) pairs whose key starts with `prefix`, in key order, past `after`."""
        rows = self.db.execute(
            'SELECT id, body FROM records WHERE kind=? AND id>? AND id<? ORDER BY id',
            (kind, after if after is not None else prefix, prefix_end(prefix)))
        return [(key, json.loads(body)) for key, body in rows]

    def delete_prefix(self, kind, prefix, *, through=None):
        """Delete records whose key starts with `prefix`, or only those up to `through`."""
        if through is None:
            self.db.execute('DELETE FROM records WHERE kind=? AND id>=? AND id<?', (kind, prefix, prefix_end(prefix)))
        else:
            self.db.execute('DELETE FROM records WHERE kind=? AND id>=? AND id<=?', (kind, prefix, through))

    def delete_kind(self, kind):
        """Delete every record of `kind`; returns how many there were."""
        return self.db.execute('DELETE FROM records WHERE kind=?', (kind,)).rowcount

    def usage(self, kind, prefix, field, *, excluding=None):
        """(count, sum of `field`) over records under `prefix`, without decoding their bodies in Python.

        Attachments are kept whole in their records; counting them must never
        load every file into memory.
        """
        count, total = self.db.execute(
            "SELECT COUNT(*), COALESCE(SUM(json_extract(body, '$.' || ?)), 0) FROM records WHERE kind=? AND id>=? AND id<? AND id IS NOT ?",
            (field, kind, prefix, prefix_end(prefix), excluding)).fetchone()
        return count, total

    @contextmanager
    def snapshot(self):
        """A consistent read across several statements (a board row and its pieces).

        It only reads, so ending it never writes: a failed read rolls back and
        leaves the connection ready for the next request.
        """
        self.db.execute('BEGIN')
        try:
            yield self
        except BaseException:
            self.db.execute('ROLLBACK')
            raise
        self.db.execute('COMMIT')


def prefix_end(prefix):
    """The smallest key greater than every key that starts with `prefix`."""
    return prefix[:-1] + chr(ord(prefix[-1]) + 1)
