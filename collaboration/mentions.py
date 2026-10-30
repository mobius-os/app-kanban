"""Mention notifications between Kanban deployments.

A comment can name board members (`mentions`: their member keys). The board
host keeps one outbox record per mentioned member and wakes that member's
deployment. The member then pulls its mentions over its own authenticated
membership and acknowledges them, so a forged wake can only cause a harmless
pull. A member that cannot be reached (offline, or on an older Kanban without
the wake route) is retried with backoff (RETRY_DELAYS) until MENTION_TTL, and
is also handed its mentions the next time its own Kanban syncs the board.

The member keeps an inbox of the mentions it received: unread ones drive the
board's @ badges, and each new one notifies its owner once.

Functions here touch only the store; the Service owns transactions, network
calls and notifications.
"""
import re
import uuid

OUTBOX = 'mention-out'  # board host: <oid>/<mention id>
INBOX = 'mention-in'    # member: <host>/<oid>/<mention id>
MAX_MENTIONS = 20
SNIPPET_CHARS = 160
TITLE_CHARS = 120
MENTION_TTL = 7 * 86400
# Five minutes, then backing off to hourly, so an unreachable deployment is
# retried promptly at first without being hammered for a whole week.
RETRY_DELAYS = (300, 600, 1200, 2400, 3600)
INBOX_LIMIT = 500
READ_TTL = 30 * 86400
TAG_UNSAFE = re.compile(r'[^A-Za-z0-9_.:-]')


def mention_targets(row, raw, author_host):
    """The member keys a new comment may notify, in order and without repeats.

    Only admitted members count, never the author: a member removed or still
    pending since the writer picked them is silently left out.
    """
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_MENTIONS:
        return []
    keys = []
    for key in raw:
        member = row['members'].get(key) if isinstance(key, str) else None
        if not member or member.get('pending') or member.get('host') == author_host or key in keys:
            continue
        keys.append(key)
    return keys


def queue(store, now, row, card_id, card, comment, keys):
    """Record one outbox entry per mentioned member, due immediately."""
    for key in keys:
        mention_id = uuid.uuid4().hex
        store.put(OUTBOX, f"{row['id']}/{mention_id}", {
            'id': mention_id, 'oid': row['id'], 'member': key, 'member_host': row['members'][key]['host'],
            'card_id': card_id, 'card_title': str(card.get('title') or '')[:TITLE_CHARS],
            'comment_id': comment['id'], 'author': comment['by']['name'],
            'snippet': comment['text'][:SNIPPET_CHARS], 'at': comment['at'],
            'attempts': 0, 'next_at': now, 'expires_at': now + MENTION_TTL,
        })


def _scan(store, kind, prefix):
    return [value for _, value in store.scan(kind, prefix)]  # scan yields (key, value)


def public(record):
    return {k: record[k] for k in ('id', 'card_id', 'card_title', 'comment_id', 'author', 'snippet', 'at')}


def _live(store, oid, now):
    """Outbox records of one board (or every board), dropping expired ones."""
    records = _scan(store, OUTBOX, f'{oid}/') if oid else store.list(OUTBOX)
    live = []
    for record in records:
        if record['expires_at'] <= now:
            store.delete(OUTBOX, f"{record['oid']}/{record['id']}")
        else:
            live.append(record)
    return live


def pending_count(store, oid, member_key, now):
    return sum(1 for r in _scan(store, OUTBOX, f'{oid}/') if r['member'] == member_key and r['expires_at'] > now)


def take(store, oid, member_key, ack, now):
    """A member's pull: forget what it acknowledged, return what is still waiting."""
    acked = set(ack) if isinstance(ack, list) else set()
    waiting = []
    for record in _live(store, oid, now):
        if record['member'] != member_key:
            continue
        if record['id'] in acked:
            store.delete(OUTBOX, f"{oid}/{record['id']}")
        else:
            waiting.append(public(record))
    return waiting


def claim_due(store, now, oid=None):
    """Due records grouped by (member host, board), rescheduled before any delivery.

    Claiming first means a crash or a concurrent run can never deliver the
    same wake in a tight loop; a successful delivery removes the records
    through the member's acknowledgement instead.
    """
    groups = {}
    for record in _live(store, oid, now):
        if record['next_at'] > now:
            continue
        record['attempts'] += 1
        record['next_at'] = now + RETRY_DELAYS[min(record['attempts'] - 1, len(RETRY_DELAYS) - 1)]
        store.put(OUTBOX, f"{record['oid']}/{record['id']}", record)
        groups.setdefault((record['member_host'], record['oid']), []).append(record)
    return groups


def drop(store, oid, member_host):
    """Forget every waiting mention for a deployment that is no longer a member."""
    for record in _scan(store, OUTBOX, f'{oid}/'):
        if record['member_host'] == member_host:
            store.delete(OUTBOX, f"{oid}/{record['id']}")


def inbox_accept(store, host, oid, items, now):
    """Keep newly received mentions; returns only the ones never seen before."""
    fresh = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not isinstance(item.get('card_id'), str):
            continue
        key = f"{host}/{oid}/{item['id']}"
        if store.get(INBOX, key):
            continue
        entry = {**public({k: item.get(k, '') for k in ('id', 'card_id', 'card_title', 'comment_id', 'author', 'snippet', 'at')}),
                 'host': host, 'oid': oid, 'read': False, 'received_at': now}
        store.put(INBOX, key, entry)
        fresh.append(entry)
    _prune(store, now)
    return fresh


def _prune(store, now):
    entries = store.list(INBOX)
    for entry in entries:
        if entry['read'] and now - entry['received_at'] > READ_TTL:
            store.delete(INBOX, f"{entry['host']}/{entry['oid']}/{entry['id']}")
    entries = sorted(store.list(INBOX), key=lambda e: e['received_at'])
    for entry in entries[:max(0, len(entries) - INBOX_LIMIT)]:
        store.delete(INBOX, f"{entry['host']}/{entry['oid']}/{entry['id']}")


def unread_counts(store, host, oid):
    counts = {}
    for entry in _scan(store, INBOX, f'{host}/{oid}/'):
        if not entry['read']:
            counts[entry['card_id']] = counts.get(entry['card_id'], 0) + 1
    return counts


def mark_read(store, host, oid, card_id):
    for entry in _scan(store, INBOX, f'{host}/{oid}/'):
        if entry['card_id'] == card_id and not entry['read']:
            entry['read'] = True
            store.put(INBOX, f"{host}/{oid}/{entry['id']}", entry)


def notification(entry, app_id):
    """The owner's push for one received mention. Its tap opens the card's Comments tab."""
    title = entry.get('card_title') or 'a card'
    return {
        'title': f"{entry.get('author') or 'Someone'} mentioned you",
        'body': f"{title}: {entry.get('snippet', '')}"[:240],
        'tag': TAG_UNSAFE.sub('-', f"kanban-mention:{entry['oid']}:{entry['card_id']}")[:128],
        'target': f"/shell/?app={app_id}&intent=mention:{entry['oid']}:{entry['card_id']}",
    }
