"""Kanban's independent, capability-authorized board service.

Host HTTPS authenticates the board authority. A random credential authorizes
one admitted member of one board; roles always come from the host transaction,
never a claimed host/name or a client-supplied role. Credentials travel only
in bounded HTTPS POST bodies and stay in server-side membership records.
There are no Social keys, messages, imports, callback key lookups or live-data
migration side effects. Public invitation delivery is explicitly unverified
until the recipient chooses to redeem it against the claimed HTTPS authority.
"""
import asyncio
import base64
import copy
import hashlib
import json
import re
import secrets
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import quote, unquote

from .store import Store
from .transport import federation_request

PROTOCOL = 'kanban/1'
SERVICE_ID = 'kanban'  # Stable public service identity, not a display name.
ID = re.compile(r'^[a-f0-9]{32}$')
HOST = re.compile(r'^[a-z0-9](?:[a-z0-9.-]{0,250}[a-z0-9])?(?::[0-9]{1,5})?$')
SECRET = re.compile(r'^[A-Za-z0-9_-]{32,128}$')
ASSET = re.compile(r'^[A-Za-z0-9_-]{1,80}$')
# A board is stored in pieces (see "Board pieces" below) and saves and polls
# exchange only the pieces that changed, so this limit now bounds what a member
# downloads when opening the board for the first time (or after the change log
# no longer reaches back to their copy), not the cost of every edit.
# TODO(board size): when real boards approach MAX_DOC, page the cards within
# each list and send a first copy in chunks instead of raising this further.
# Members learn these limits from the board object (`limits`); keep the
# fallbacks in domain.js in step for hosts that do not report them.
MAX_DOC = 2 * 1024 * 1024
MAX_ASSET = 5 * 1024 * 1024
MAX_BOARD_FILES = 500
MAX_BOARD_FILE_BYTES = 100 * 1024 * 1024
# Saves since this many versions ago can be sent as changes; an older copy is
# replaced by the whole board.
MAX_CHANGE_LOG = 1000
# Card details live beside the board in one 'card' record per card. A long
# description keeps only a preview on the board; activity is never on it.
# Keep these in step with activity.js.
NOTES_PREVIEW_CHARS = 400
MAX_NOTES_CHARS = 16000
MAX_ACTIVITY_PER_CARD = 100
MAX_ACTIVITY_TEXT = 300
MAX_ACTIVITY_APPEND = 40
# Comments live in the card record like a long description; the board card
# only carries their count. Keep these in step with comments.js.
MAX_COMMENT_CHARS = 2000
MAX_COMMENTS_PER_CARD = 200
ACTIVITY_TYPES = frozenset((
    'created', 'completed', 'renamed', 'notes', 'moved', 'label', 'due', 'assigned', 'commented',
    'checklist-added', 'checklist-removed', 'checklist-checked', 'checklist-unchecked', 'checklist-edited',
    'attachment-added', 'attachment-removed', 'pr-added', 'pr-removed', 'pr-changed',
))
ACTIVITY_ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
# The card fields each kind of activity entry describes (see verified_activity).
ACTIVITY_FIELDS = {
    'renamed': ('title',), 'notes': ('notes', 'notesLength'), 'label': ('label',), 'due': ('due',),
    'assigned': ('assignee', 'assigneeHost'), 'commented': ('commentsCount',),
    **{kind: ('checklist',) for kind in ('checklist-added', 'checklist-removed', 'checklist-checked',
                                          'checklist-unchecked', 'checklist-edited')},
    'attachment-added': ('attachments',), 'attachment-removed': ('attachments',),
    **{kind: ('pullRequestUrls', 'pullRequestUrl') for kind in ('pr-added', 'pr-removed', 'pr-changed')},
}
# The 0.6 document kept at the 0.7 upgrade (store_boards_in_pieces) is deleted
# after this long; migration_tools/whole_boards.py --drop-backups deletes it sooner.
BACKUP_DAYS = 30
CARD_ID = re.compile(r'^[A-Za-z0-9_-]{1,80}$')
PRESENCE_TTL = 12
# Members poll every 1-3 s. Persisting `seen` only once it is this old keeps
# every polling member inside PRESENCE_TTL while most polls write nothing. It
# stays at a third of the TTL so a lost poll on a slow link (up to the 10 s
# request timeout) still leaves the saved age inside it.
SEEN_REFRESH = 4
# Operations that change nothing but presence; they skip the write lock unless
# presence or the display name actually needs persisting.
READ_ONLY_OPS = ('state', 'asset-read', 'card-read')
INVITE_TTL = 7 * 86400


class Failure(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message
        super().__init__(message)


def fail(status, code, message):
    raise Failure(status, code, message)


def check(value, pattern, name):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        fail(400, 'invalid-request', f'Invalid {name}.')
    return value


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def activity_time(value):
    if not isinstance(value, str) or len(value) > 40:
        fail(400, 'invalid-activity', 'Activity time is invalid.')
    try:
        stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        fail(400, 'invalid-activity', 'Activity time is invalid.')
    if stamp.tzinfo is None:
        fail(400, 'invalid-activity', 'Activity time needs a timezone.')
    return stamp.timestamp()


def activity_entries(raw, actor, at):
    """Validate a writer's description of its change; the host stamps who, when and how.

    The writer only describes what changed. The author is the member the host
    authenticated, the time is the host's clock, and `via: 'agent'` comes from
    the authenticated request (see agent_request), never from an entry. Types
    this host does not know come from a newer Kanban and are skipped, so a
    member that updated first never has its edits refused.
    """
    if not isinstance(raw, list) or len(raw) > MAX_ACTIVITY_APPEND:
        fail(400, 'invalid-activity', 'Activity must be a short list.')
    entries = []
    for item in raw:
        if not isinstance(item, dict):
            fail(400, 'invalid-activity', 'Activity entries must be objects.')
        entry_id = check(item.get('id'), ACTIVITY_ID, 'activity id')
        if item.get('type') not in ACTIVITY_TYPES:
            continue
        entry = {'id': entry_id, 'at': at, 'type': item['type'],
                 'by': {'host': actor['host'], 'name': actor.get('name') or actor['host']}}
        for key in ('from', 'to', 'text'):
            if key in item:
                if not isinstance(item[key], str): fail(400, 'invalid-activity', 'Activity text is invalid.')
                entry[key] = item[key].strip()[:MAX_ACTIVITY_TEXT]
        if actor.get('via') == 'agent': entry['via'] = 'agent'
        entries.append(entry)
    return entries


def merge_activity(existing, incoming):
    """Union by id, oldest first. Entries of one change share a time and keep their order."""
    merged = {}
    for entry in [*existing, *incoming]:
        merged.setdefault(entry['id'], entry)
    ordered = sorted(merged.values(), key=lambda entry: activity_time(entry['at']))
    return ordered[-MAX_ACTIVITY_PER_CARD:]


def attachment_ids(card):
    """The ids of the files a card attaches."""
    files = card.get('attachments') if isinstance(card, dict) else None
    return {f['id'] for f in files if isinstance(f, dict) and isinstance(f.get('id'), str)} if isinstance(files, list) else set()


def event_ids(card):
    """The ids of a card's assignment events (assignment.js)."""
    events = card.get('assignmentHistory') if isinstance(card, dict) else None
    return {e.get('id') for e in events if isinstance(e, dict)} if isinstance(events, list) else set()


COMPLETION_MARK = '✅ Done — '


def completion_or_notes(entries, before, after):
    """The activity a description save may carry: that the description changed,
    or that the card was completed when the save adds its completion line
    (operations.js completeCardNotes). Anything else is dropped."""
    kept = []
    for entry in entries:
        if entry['type'] == 'completed':
            line = COMPLETION_MARK + entry.get('text', '')
            if line not in after or line in before: continue
            entry.pop('from', None); entry.pop('to', None)
        elif entry['type'] != 'notes':
            continue
        kept.append(entry)
    return kept


def card_column(columns, card_id):
    """The name of the list holding `card_id`, or '' when none does."""
    for column in columns if isinstance(columns, list) else []:
        if isinstance(column, dict) and card_id in (column.get('cardIds') or []):
            return str(column.get('name') or '')
    return ''


def assignee_name(card):
    return str(card.get('assignee') or card.get('assigneeHost') or '').strip()


def verified_activity(entries, before, after, column_before, column_after):
    """Keep only entries that describe what this edit actually changed on the card.

    A writer describes its own edit, so an entry must match a change to the
    card (`before` -> `after`, None when the card did not exist). Where the
    host can read the facts itself (titles, lists, label, due date, assignee)
    it writes them, rather than trusting the writer's words.
    """
    before = before if isinstance(before, dict) else None
    changed = lambda fields: before is not None and any(before.get(f) != after.get(f) for f in fields)
    clip = lambda value: str(value or '').strip()[:MAX_ACTIVITY_TEXT]
    kept = []
    for entry in entries:
        kind = entry['type']
        if kind == 'created':
            if before is not None: continue
            entry.update(to=clip(column_after)); entry.pop('from', None)
        elif kind == 'completed':
            if before is None or (before == after and column_before == column_after): continue
        elif kind == 'moved':
            if before is None or column_before == column_after: continue
            entry.update({'from': clip(column_before), 'to': clip(column_after)})
        elif not changed(ACTIVITY_FIELDS[kind]):
            continue
        elif kind == 'renamed':
            entry.update({'from': clip(before.get('title')), 'to': clip(after.get('title'))})
        elif kind in ('label', 'due'):
            entry.update({'from': clip(before.get(kind)), 'to': clip(after.get(kind))})
            for side in ('from', 'to'):
                if kind == 'label' and entry[side] == 'none': entry[side] = ''
        elif kind == 'assigned':
            entry.update({'from': clip(assignee_name(before)), 'to': clip(assignee_name(after))})
            # Its id names the assignment event this edit added (the card sheet
            # shows them as one line); it may never claim an earlier event.
            if entry['id'] in event_ids(before):
                entry['id'] = uuid.uuid4().hex
        kept.append(entry)
    return kept


def agent_request(actor):
    """Whether an authenticated request on this deployment comes from an agent.

    The Kanban app's own frame calls with the app's token; the agent helper
    (scripts/kanban.mjs) and delegated helpers call with an owner or delegated
    token. A member's deployment forwards this as `via` for its own requests;
    the board host trusts it exactly as far as it trusts that member's `by`.
    """
    return actor.get('scope') == 'owner' or bool(actor.get('delegated'))


def notes_preview(notes):
    return notes if len(notes) <= NOTES_PREVIEW_CHARS else notes[:NOTES_PREVIEW_CHARS - 1].rstrip() + '…'


def board_shape(doc):
    if not isinstance(doc, dict) or not isinstance(doc.get('columns'), list) or not isinstance(doc.get('cards'), dict):
        fail(400, 'invalid-board', 'A board must contain columns and cards.')
    return doc


def document(doc):
    board_shape(doc)
    try:
        raw = json.dumps(doc, allow_nan=False).encode()
    except (ValueError, TypeError):
        fail(400, 'invalid-board', 'The board is not valid JSON.')
    if len(raw) > MAX_DOC:
        fail(413, 'board-too-large', 'The board is too large.')
    return doc


# ---- Board pieces
#
# The board row keeps the lists ('columns') and the other top-level settings
# ('meta'); each card is a 'board-card' record keyed '<board>/<card>'; every save
# appends a 'board-change' record keyed '<board>/<version>' that names the pieces
# it changed. A member holding version N asks for the pieces changed since N
# and saves only the pieces it changed. Two saves conflict only when they touch
# the same piece, never merely because both happened.

BOARD_PIECES = ('cards', 'columns')


def card_key(oid, card_id):
    return f'{oid}/{card_id}'


def change_key(oid, version):
    return f'{oid}/{version:012d}'


def card_entry_bytes(card_id, card):
    """This card's share of `json.dumps(board)`, including its separator."""
    try:
        return len(json.dumps(card_id)) + len(json.dumps(card, allow_nan=False)) + 4
    except (ValueError, TypeError):
        fail(400, 'invalid-board', 'The board is not valid JSON.')


def document_bytes(meta, columns, cards_bytes, card_count):
    """`len(json.dumps(board))` from the stored pieces, without assembling the board."""
    skeleton = len(json.dumps({**meta, 'columns': columns, 'cards': {}}, allow_nan=False))
    return skeleton + (cards_bytes - 2 if card_count else 0)


def piece_changes(raw):
    """Validate a member's changed pieces: {'cards': {id: card or None}, 'columns'?: [...], 'meta'?: {...}}."""
    if not isinstance(raw, dict) or not raw or set(raw) - {'cards', 'columns', 'meta'}:
        fail(400, 'invalid-board', 'Board changes must name cards, columns or meta.')
    cards = raw.get('cards', {})
    if not isinstance(cards, dict) or any(not CARD_ID.fullmatch(k) or not (v is None or isinstance(v, dict)) for k, v in cards.items()):
        fail(400, 'invalid-board', 'Invalid card changes.')
    if 'columns' in raw and not isinstance(raw['columns'], list):
        fail(400, 'invalid-board', 'A board must contain columns and cards.')
    if 'meta' in raw and (not isinstance(raw['meta'], dict) or set(raw['meta']) & set(BOARD_PIECES)):
        fail(400, 'invalid-board', 'Invalid board settings.')
    return {'cards': cards, **{k: raw[k] for k in ('columns', 'meta') if k in raw}}


def board_difference(before, after):
    """The pieces an older Kanban's whole-board save changed, in the shape piece_changes returns."""
    cards = {cid: card for cid, card in after['cards'].items() if before['cards'].get(cid) != card}
    cards.update({cid: None for cid in before['cards'] if cid not in after['cards']})
    pieces = {'cards': cards}
    if after['columns'] != before['columns']:
        pieces['columns'] = after['columns']
    meta = {k: v for k, v in after.items() if k not in BOARD_PIECES}
    if meta != {k: v for k, v in before.items() if k not in BOARD_PIECES}:
        pieces['meta'] = meta
    return pieces


def touched_pieces(pieces):
    return {'card:' + cid for cid in pieces['cards']} | {name for name in ('columns', 'meta') if name in pieces}


class Service:
    def __init__(self, root, *, host, app_id, request=federation_request, resolve=None, owner_name=None, now=time.time):
        self.store = Store(root)
        self.host = check(host, HOST, 'instance host')
        self.app_id = app_id
        self.request = request
        self.resolve = resolve
        self.owner_name = str(owner_name or '').strip() or self.host
        self.now = now
        self.store_boards_in_pieces()
        self.expire_backups()

    def store_boards_in_pieces(self):
        """Convert boards saved as one document (Kanban 0.6 and older) once, when the service starts.

        All boards convert in one transaction: a failure leaves every board as
        it was and the next start tries again. Each board's document is kept,
        exactly as it was, in a 'board-backup' record that nothing else reads,
        for BACKUP_DAYS (expire_backups); migration_tools/whole_boards.py turns
        pieces back into documents for a downgrade (README: "Storage upgrade in 0.7").
        """
        if self.store.get('schema', 'board-pieces'):
            return
        with self.store.transaction():
            if self.store.get('schema', 'board-pieces'):
                return
            for row in self.store.list('board'):
                if 'doc' in row:
                    self.store.put('board-backup', row['id'], {'version': row['version'], 'doc': row['doc'],
                        'saved_at': self.stamp()})
                    self.write_board_pieces(row, copy.deepcopy(row.pop('doc')))
                    self.store.put('board', row['id'], row)
                    self.store.put('schema', 'backup-expiry', {'at': self.now() + BACKUP_DAYS * 86400})
            self.store.put('schema', 'board-pieces', {'version': 1})

    def expire_backups(self):
        """Delete the upgrade backups once BACKUP_DAYS have passed: they hold content deleted since.

        Every backup comes from the one upgrade, so one expiry time covers them
        all, and a request reads only that small record.
        """
        expiry = self.store.get('schema', 'backup-expiry')
        if not expiry or self.now() < expiry['at']:
            return
        with self.store.transaction():
            self.store.delete_kind('board-backup')
            self.store.delete('schema', 'backup-expiry')

    def write_board_pieces(self, row, doc):
        """Store a whole board as `row`'s pieces, replacing any it had.

        It has no change history: a member's next poll receives the whole
        board. Long descriptions move into card records here, as a save would.
        """
        oid = row['id']
        self.store.delete_prefix('board-card', oid + '/')
        self.store.delete_prefix('board-change', oid + '/')
        total = 0
        for card_id, card in doc['cards'].items():
            if isinstance(card, dict) and isinstance(card.get('notes'), str) \
                    and len(card['notes']) > NOTES_PREVIEW_CHARS and not isinstance(card.get('notesLength'), int):
                record = self.card_record(row, card_id)
                record['notes'] = card['notes']
                self.store.put('card', card_key(oid, card_id), record)
                card['notesLength'] = len(card['notes'])
                card['notes'] = notes_preview(card['notes'])
            size = card_entry_bytes(card_id, card)
            total += size
            self.store.put('board-card', card_key(oid, card_id), {'card': card, 'bytes': size})
        row.update(columns=doc['columns'], meta={k: v for k, v in doc.items() if k not in BOARD_PIECES},
                   cards_bytes=total, card_count=len(doc['cards']), log_floor=row['version'])

    def board_document(self, row):
        cards = {key.split('/', 1)[1]: piece['card'] for key, piece in self.store.scan('board-card', row['id'] + '/')}
        return {**row['meta'], 'columns': row['columns'], 'cards': cards}

    def board_card(self, row, card_id):
        piece = self.store.get('board-card', card_key(row['id'], card_id))
        return piece['card'] if piece else None

    def changes_since(self, row, since):
        """The pieces changed after version `since`, or None when the log no longer reaches back that far."""
        if since < row['log_floor'] or since > row['version']:
            return None
        cards, columns, meta = set(), False, False
        for _, entry in self.store.scan('board-change', row['id'] + '/', after=change_key(row['id'], since)):
            cards.update(entry['cards'])
            columns = columns or entry['columns']
            meta = meta or entry['meta']
        changes = {'cards': {cid: self.board_card(row, cid) for cid in sorted(cards)}}
        if columns: changes['columns'] = row['columns']
        if meta: changes['meta'] = row['meta']
        return changes

    def touched_since(self, row, since):
        touched = set()
        for _, entry in self.store.scan('board-change', row['id'] + '/', after=change_key(row['id'], since)):
            touched |= touched_pieces({'cards': dict.fromkeys(entry['cards']),
                **{name: True for name in ('columns', 'meta') if entry[name]}})
        return touched

    def since_reply(self, row, since):
        """What a member holding version `since` needs to reach the current version."""
        changes = self.changes_since(row, since)
        if changes is None:
            return {'version': row['version'], 'doc': self.board_document(row)}
        return {'version': row['version'], 'since': since, 'changes': changes}

    def commit_pieces(self, row, pieces):
        """Save changed pieces as the board's next version and log which pieces changed.

        The caller persists `row`. Refuses a board that would pass MAX_DOC.
        """
        oid = row['id']
        cards = pieces['cards']
        total, count, stored = row['cards_bytes'], row['card_count'], {}
        for card_id, card in cards.items():
            previous = self.store.get('board-card', card_key(oid, card_id))
            if previous:
                total -= previous['bytes']; count -= 1
            if card is not None:
                stored[card_id] = {'card': card, 'bytes': card_entry_bytes(card_id, card)}
                total += stored[card_id]['bytes']; count += 1
        columns = pieces.get('columns', row['columns'])
        meta = pieces.get('meta', row['meta'])
        if document_bytes(meta, columns, total, count) > MAX_DOC:
            fail(413, 'board-too-large', 'The board is too large.')
        # A file belongs to the card that attaches it: removing it from the card,
        # or deleting the card (alone or with its list), deletes it, unless
        # another card on the board still attaches it. Clients only remove a
        # file by naming it ('remove-file' in operations.js); a whole list of
        # files from an older or stale writer can only add.
        released = set()
        for card_id in cards:
            previous = self.store.get('board-card', card_key(oid, card_id))
            kept = attachment_ids(stored[card_id]['card']) if card_id in stored else set()
            released |= attachment_ids(previous['card'] if previous else None) - kept
        if released:
            for key, piece in self.store.scan('board-card', oid + '/'):
                if key.split('/', 1)[1] not in cards:
                    released -= attachment_ids(piece['card'])
            for piece in stored.values():
                released -= attachment_ids(piece['card'])
        for asset_id in released:
            self.store.delete('asset', f'{oid}/{asset_id}')
        for card_id in cards:
            if card_id in stored:
                self.store.put('board-card', card_key(oid, card_id), stored[card_id])
            else:
                self.store.delete('board-card', card_key(oid, card_id))
                self.store.delete('card', card_key(oid, card_id))
        row.update(columns=columns, meta=meta, cards_bytes=total, card_count=count)
        row['version'] += 1
        row['label'] = str(meta.get('title') or row['label'])[:120]
        self.store.put('board-change', change_key(oid, row['version']), {'version': row['version'],
            'cards': sorted(cards), 'columns': 'columns' in pieces, 'meta': 'meta' in pieces})
        floor = row['version'] - MAX_CHANGE_LOG
        if floor > row['log_floor']:
            self.store.delete_prefix('board-change', oid + '/', through=change_key(oid, floor))
            row['log_floor'] = floor

    def close(self):
        self.store.close()

    def stamp(self):
        """The host's current time as an activity timestamp."""
        return datetime.fromtimestamp(self.now(), timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

    def owner(self, actor, *, write=False):
        if actor.get('scope') not in ('owner', 'app') or (actor.get('scope') == 'app' and actor.get('app_id') != self.app_id):
            fail(403, 'wrong-principal', 'Only this Kanban app or its owner may do that.')
        if write and actor.get('delegated'):
            fail(403, 'delegated-action', 'This action requires the owner, not a delegated agent.')

    def board(self, oid):
        check(oid, ID, 'board id')
        row = self.store.get('board', oid)
        if not row:
            fail(404, 'board-missing', 'The board does not exist at this authority.')
        if row.get('staged'):
            fail(409, 'migration-staged', 'The board handoff is not active. Pending edits are retained.')
        if row.get('retired'):
            fail(409, 'authority-retired', 'This board authority has been retired. Pending edits are retained.')
        return row

    def public(self, row):
        members = {}
        for key, member in row['members'].items():
            last = member.get('seen', 0)
            members[key] = {k:v for k,v in member.items() if k in ('host','name','handle','role','pending','collaborator_id','host_owner')}
            members[key]['member_id'] = key
            members[key]['active'] = not member.get('pending') and 0 <= self.now()-last <= PRESENCE_TTL
        return {'handoff':row.get('handoff'), 'local_id':row.get('local_id'), 'id':row['id'], 'host':self.host, 'app':'kanban', 'kind':'board', 'label':row['label'], 'version':row['version'], 'members':members, 'transport':PROTOCOL,
                'limits':{'board_bytes':MAX_DOC,'files':MAX_BOARD_FILES,'file_bytes':MAX_BOARD_FILE_BYTES}}

    def member(self, row, member_id, credential):
        check(member_id, ID, 'member id')
        check(credential, SECRET, 'member credential')
        m = row['members'].get(member_id)
        if not m or not secrets.compare_digest(m.get('credential_hash',''), digest(credential)):
            fail(403, 'membership-revoked', 'This board credential is not authorized.')
        return m

    def presence_changes(self, member, name):
        """Return the presence fields worth persisting for this request."""
        changes = {}
        now = self.now()
        if not 0 <= now - member.get('seen', 0) < SEEN_REFRESH:
            changes['seen'] = now
        if name and member.get('name') != name:
            changes['name'] = name
        return changes

    @staticmethod
    def claimed_name(body):
        name = body.get('name')
        return name.strip()[:128] if isinstance(name, str) and name.strip() else None

    def peer_read(self, oid, op, body):
        """Answer a member's read-only request without the write lock.

        Returns None when presence or the name must be persisted; the caller
        then takes the transactional path, which re-checks the membership.
        """
        with self.store.snapshot():
            row = self.board(oid)
            mid = check(body.get('member_id'),ID,'member id')
            credential = check(body.get('credential'),SECRET,'member credential')
            member = self.member(row,mid,credential)
            if member.get('pending'):
                fail(409,'invitation-pending','Accept the invitation before using this board.')
            if self.presence_changes(member, self.claimed_name(body)):
                return None
            return self.operation(row,op,body,{'host':member['host'],'name':member.get('name')})

    def state(self, row, since=-1, changes=False):
        """The board object, plus what changed since `since`: changed pieces when
        the member asked for `changes` and the log reaches back, else the whole board."""
        result = {'status':'ok', 'version':row['version'], 'object':self.public(row)}
        if row['version'] > since:
            result.update(self.since_reply(row, since) if changes and since >= 0
                else {'doc': self.board_document(row)})
        return result

    async def remote(self, host, oid, payload):
        check(host, HOST, 'board host'); check(oid, ID, 'board id')
        try:
            response = await self.request('POST', f'https://{host}/api/app-services/{SERVICE_ID}/peer/{oid}', json={'protocol':PROTOCOL, **payload}, max_response_bytes=8*1024*1024, timeout_seconds=10)
        except Exception as exc:
            raise Failure(502, 'authority-unavailable', 'The board host could not be reached. Pending edits are retained.') from exc
        try:
            data = response.json()
        except Exception:
            fail(502, 'authority-unavailable', 'The board host returned an invalid response.')
        # A gateway 404/403 does not establish deletion or revocation.
        if not isinstance(data, dict) or data.get('protocol') != PROTOCOL:
            fail(502, 'authority-unavailable', 'The remote Kanban service is unavailable or needs updating.')
        if response.status_code >= 400:
            code = data.get('code')
            if not isinstance(code, str):
                fail(502, 'authority-unavailable', 'The remote Kanban service could not confirm the request.')
            fail(response.status_code, code, str(data.get('detail') or 'The board host refused the request.'))
        return data

    def new_board(self, body):
        doc = document(body.get('doc'))
        if body.get('app', 'kanban') != 'kanban':
            fail(403, 'wrong-app', 'This service owns Kanban boards only.')
        oid = check(body['id'], ID, 'board id') if body.get('id') else uuid.uuid4().hex
        local_id = body.get('local_id')
        if local_id is not None and (not isinstance(local_id,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,199}',local_id)):
            fail(400,'invalid-local-id','Invalid local board identity.')
        row = {'id':oid,'local_id':local_id,'label':str(body.get('label') or doc.get('title') or 'Board')[:120], 'version':1,
               'members':{self.host:{'host':self.host,'name':self.owner_name,'role':'editor','host_owner':True,'seen':self.now()}}, 'invites':{}}
        with self.store.transaction():
            existing = self.store.get('board',oid)
            if existing:
                if existing.get('staged'):
                    fail(409,'migration-staged','The board handoff is not active.')
                if not local_id or existing.get('local_id') != local_id:
                    fail(409,'board-id-conflict','This identity already names another board.')
                return {'id':oid,'host':self.host,'version':existing['version'],'transport':PROTOCOL}
            self.write_board_pieces(row, doc)
            self.store.put('board',oid,row)
        return {'id':oid,'host':self.host,'version':1,'transport':PROTOCOL}

    def mint_invite(self, oid, role, *, target=None, group=None, ttl=INVITE_TTL):
        return self.mint_grants(oid, role, [target], group=group, ttl=ttl)[0]

    def mint_grants(self, oid, role, targets, *, group=None, ttl=INVITE_TTL):
        if role not in ('editor','viewer'):
            fail(400,'invalid-role','Role must be editor or viewer.')
        if type(ttl) is not int or not 1 <= ttl <= INVITE_TTL:
            fail(400,'invalid-expiry','Invitations expire within seven days.')
        grants = []
        with self.store.transaction():
            row = self.board(oid)
            row['invites'] = {k:v for k,v in row['invites'].items() if v['expires_at'] > self.now()}
            if len(row['invites']) + len(targets) > 100:
                fail(429,'invitations-full','This board has too many outstanding invitations.')
            expires = self.now() + ttl
            for target in targets:
                secret = secrets.token_urlsafe(32)
                row['invites'][digest(secret)] = {'role':role, 'expires_at':expires, 'target':target, 'group':group}
                grants.append({'invite':f'{oid}@{self.host}#{secret}', 'role':role, 'expires_at':expires})
            self.store.put('board',oid,row)
        return grants

    async def invite(self, oid, body):
        role = body.get('role','editor')
        if not body.get('address'):
            return self.mint_invite(oid,role,ttl=body.get('ttl_seconds',INVITE_TTL))
        address = str(body['address']).strip().lower().lstrip('@')
        group = None
        if '@' in address or '.' in address:
            hosts = [check(address.rsplit('@',1)[-1],HOST,'recipient address')]
        else:
            if not self.resolve:
                fail(503,'identity-unavailable','Handle lookup is unavailable. Use a full deployment address.')
            hosts = await self.resolve(address)
            if not hosts:
                fail(404,'identity-missing','That handle has no linked deployments.')
            hosts = list(dict.fromkeys(check(h,HOST,'linked deployment') for h in hosts))
            group = digest('registry:'+address)
        if len(hosts) > 20 or self.host in hosts:
            fail(400,'invalid-recipients','Choose other deployments, up to twenty at once.')
        # Mint the bounded batch atomically before any delivery, then overlap
        # independent network waits. One slow recipient must not starve later
        # recipients until the platform's per-request lifetime expires.
        meta = self.public(self.board(oid))
        grants = self.mint_grants(oid, role, hosts, group=group)
        async def deliver(host, minted):
            try:
                response = await self.request('POST',f'https://{host}/api/app-services/{SERVICE_ID}/invitations/deliver',
                    json={'protocol':PROTOCOL,'invite':minted['invite'],'label':meta['label'],'role':role}, max_response_bytes=32768, timeout_seconds=10)
                valid = response.status_code == 200 and response.json().get('protocol') == PROTOCOL
            except Exception:
                valid = False
            return {'host':host,'delivery':'delivered' if valid else 'unreachable'}
        results = await asyncio.gather(*(deliver(host, minted) for host, minted in zip(hosts, grants)))
        count = sum(item['delivery']=='delivered' for item in results)
        return {'status':'invited','role':role,'recipients':results,'delivery':'delivered' if count==len(results) else 'partial' if count else 'unreachable','members':self.public(self.board(oid))['members']}

    def parse_invite(self, raw):
        try:
            address, secret = raw.split('#')
            oid, host = address.split('@')
            return check(oid,ID,'board id'),check(host,HOST,'board host'),check(secret,SECRET,'invitation')
        except (ValueError,AttributeError):
            fail(400,'invalid-invitation','The invitation is malformed.')

    def receive(self, body):
        oid,host,secret = self.parse_invite(body.get('invite'))
        key = host+'/'+oid
        with self.store.transaction():
            previous = self.store.get('invitation',key)
            declined={k:v for k,v in (previous or {}).get('declined_tokens',{}).items() if v>self.now()}
            if digest(secret) in declined or (previous and previous.get('invite')==body['invite']):
                return {'status':'delivered'}
            if len(declined)>=100:
                fail(429,'invitations-full','Invitation history for this board is full.')
            if previous is None and len(self.store.list('invitation')) >= 100:
                fail(429,'invitations-full','The invitation inbox is full.')
            self.store.put('invitation',key,{'id':oid,'host':host,'invite':body['invite'],'label':str(body.get('label') or 'Board')[:120],
                'role':body.get('role') if body.get('role') in ('editor','viewer') else 'viewer','status':'pending','received_at':self.now(), 'verified':False,'declined_tokens':declined})
        return {'status':'delivered'}

    async def join(self, body):
        raw = body.get('invite')
        if not raw:
            key = check(body.get('host'),HOST,'host')+'/'+check(body.get('id'),ID,'board id')
            pending = self.store.get('joined',key)
            invitation = self.store.get('invitation',key)
            if pending and pending.get('status') in ('joining','invited'):
                raw = pending['id']+'@'+pending['host']+'#'+pending.get('invite',pending['credential'])
            elif not invitation or invitation['status'] != 'pending':
                fail(404,'invitation-missing','No pending invitation.')
            else: raw = invitation['invite']
        oid,host,secret = self.parse_invite(raw)
        if host == self.host:
            fail(400,'already-hosted','This board is already hosted here.')
        key = host+'/'+oid
        # Persist the retry identity BEFORE host admission. A lost response or
        # a process exit after admission can retry without consuming a new invite.
        with self.store.transaction():
            member = self.store.get('joined',key)
            if not member or member.get('status') == 'revoked':
                member = {'id':oid,'host':host,'member_id':uuid.uuid4().hex,'credential':secrets.token_urlsafe(32),'status':'joining','invite':secret}
                self.store.put('joined',key,member)
            elif member.get('status') == 'invited':
                member['status']='joining'
                self.store.put('joined',key,member)
            elif member.get('status') == 'joining' and member.get('invite') != secret:
                member['invite']=secret
                self.store.put('joined',key,member)
        result = await self.remote(host,oid,{'op':'join','member_id':member['member_id'],'credential':member['credential'],
            'invite':member.get('invite',secret),'host':self.host,'name':self.owner_name})
        meta = result.get('object',{})
        admitted = meta.get('members',{}).get(member['member_id'])
        if not admitted or admitted.get('role') not in ('editor','viewer'):
            fail(502,'invalid-membership','The board host returned invalid membership.')
        member.update(status='joined',role=admitted['role'],label=meta.get('label','Board'),transport=PROTOCOL)
        member.pop('invite',None)
        with self.store.transaction():
            self.store.put('joined',key,member)
            self.store.delete('invitation',key)
        return {'status':'joined','membership':self.membership(member),'doc':result['doc'],'version':result['version']}

    async def resume_join(self):
        # A durable round-robin cursor bounds one request to one remote attempt
        # without letting an unavailable first host starve every later join.
        # Claim the next position before network I/O, including across restarts.
        with self.store.transaction():
            pending = sorted((m for m in self.store.list('joined') if m['status']=='joining'),
                             key=lambda m: m['host']+'/'+m['id'])
            if not pending:
                self.store.delete('recovery','join-cursor')
                return {'results':[]}
            cursor = (self.store.get('recovery','join-cursor') or {}).get('key','')
            member = next((m for m in pending if m['host']+'/'+m['id'] > cursor),pending[0])
            self.store.put('recovery','join-cursor',{'key':member['host']+'/'+member['id']})
        result={'id':member['id'],'host':member['host']}
        try:
            await self.join({'host':member['host'],'id':member['id']})
            result['status']='joined'
        except Failure as error:
            result.update(status='unavailable',code=error.code)
        return {'results':[result]}

    @staticmethod
    def membership(member):
        return {k:v for k,v in member.items() if k not in ('credential','invite')}

    def peer(self, oid, body):
        op = body.get('op')
        if op in READ_ONLY_OPS:
            result = self.peer_read(oid, op, body)
            if result is not None:
                return result
        with self.store.transaction():
            row = self.board(oid)
            mid = check(body.get('member_id'),ID,'member id')
            credential = check(body.get('credential'),SECRET,'member credential')
            if op == 'join':
                existing = row['members'].get(mid)
                if existing:
                    self.member(row,mid,credential)
                    existing['pending']=False;existing['seen']=self.now()
                    if isinstance(body.get('name'), str) and body['name'].strip():
                        existing['name'] = body['name'].strip()[:128]
                    self.store.put('board',oid,row)
                    return self.state(row)
                secret = check(body.get('invite'),SECRET,'invitation')
                inv = row['invites'].get(digest(secret))
                if not inv or inv['expires_at'] <= self.now():
                    fail(403,'invitation-expired','The invitation is invalid or expired.')
                claimed_host = check(body.get('host'),HOST,'member address')
                # Host/name is a locator, NOT authorization. Possession of this
                # single-use invite admits the exact credential. Never merge
                # a member into an existing principal by a claimed host/name.
                if len(row['members'])>=500:
                    fail(429,'members-full','This board has reached its member limit.')
                claimed_name = body.get('name') if isinstance(body.get('name'), str) else ''
                claimed_name = claimed_name.strip()[:128] or claimed_host
                row['members'][mid] = {'host':claimed_host,'name':claimed_name,'role':inv['role'],
                    'credential_hash':digest(credential),'seen':self.now(),
                    **({'collaborator_id':inv['group']} if inv.get('group') else {})}
                if inv.get('target') and inv['target'] != claimed_host:
                    fail(403,'wrong-invitation-target','This invitation names a different deployment.')
                row['invites'].pop(digest(secret))
                self.store.put('board',oid,row)
                return self.state(row)
            member = self.member(row,mid,credential)
            if op != 'leave' and member.get('pending'):
                fail(409,'invitation-pending','Accept the invitation before using this board.')
            if op == 'leave':
                row['members'].pop(mid)
                self.store.put('board',oid,row)
                return {'status':'left'}
            if op not in ('state','write','patch','asset-read','asset-write','asset-delete','card-read','notes-write','comment-write'):
                fail(400,'invalid-operation','Unsupported board operation.')
            if op in ('write','patch','asset-write','asset-delete','notes-write','comment-write') and member['role'] != 'editor':
                fail(403,'read-only','This board member is a viewer.')
            changes = self.presence_changes(member, self.claimed_name(body))
            member.update(changes)
            # `via` is the member deployment's statement about its own request
            # (state_operation sets it from its authenticated caller).
            result = self.operation(row,op,body,{'host':member['host'],'name':member.get('name'),
                'via':'agent' if body.get('via') == 'agent' else ''})
            if changes or op not in READ_ONLY_OPS:
                self.store.put('board',oid,row)
            return result

    def card_record(self, row, card_id):
        record = self.store.get('card',row['id']+'/'+card_id) or {
            'board_id':row['id'],'card_id':card_id,'notes':None,'notes_version':0,'activity':[]}
        # Records written before comments existed gain the empty collection.
        record.setdefault('comments', [])
        return record

    def settle_notes(self, row, cards):
        """Keep the descriptions in changed cards consistent with the card records.

        Long descriptions move out of the board into the card record. Returns
        True when it changed an incoming card, so the writer adopts the host's
        copy instead of keeping full text the board no longer carries.

        A writer may still send the full text it held before the move; that is
        the same description, not an edit. Any other change to a moved-out
        preview comes from an older Kanban that never saw the full text, and
        accepting it would truncate the description.
        """
        changed_doc = False
        for card_id, card in cards.items():
            if card is None: continue
            before = self.board_card(row, card_id) or {}
            notes = card.get('notes') if isinstance(card.get('notes'),str) else ''
            if isinstance(before.get('notesLength'),int):
                if notes != before.get('notes'):
                    if notes != self.card_record(row,card_id)['notes']:
                        # 'read-only' is the refusal an older Kanban already treats as
                        # final: it reverts the edit or keeps it for recovery, instead
                        # of retrying forever and holding back its later edits.
                        fail(403,'read-only',"This card's description is stored separately. Update Kanban to edit it.")
                    card['notes'] = before['notes']; changed_doc = True
                if card.get('notesLength') != before['notesLength']:
                    card['notesLength'] = before['notesLength']; changed_doc = True
                continue
            if 'notesLength' in card:
                card.pop('notesLength'); changed_doc = True
            previous = before.get('notes') if isinstance(before.get('notes'),str) else ''
            changed = notes != previous
            if not changed and len(notes) <= NOTES_PREVIEW_CHARS: continue
            # The same cap as a description saved on its own (card_operation), so
            # a board save cannot store an unbounded description either.
            if changed and len(notes) > MAX_NOTES_CHARS and len(notes) > len(previous):
                fail(413,'notes-too-long',f'A description can be at most {MAX_NOTES_CHARS} characters.')
            record = self.card_record(row,card_id)
            if changed: record['notes_version'] += 1
            if len(notes) > NOTES_PREVIEW_CHARS:
                record['notes'] = notes
                card['notes'] = notes_preview(notes); card['notesLength'] = len(notes)
                changed_doc = True
            self.store.put('card',card_key(row['id'],card_id),record)
        return changed_doc

    def card_operation(self, row, op, body, actor):
        card_id = check(body.get('card_id'),CARD_ID,'card id')
        key = card_key(row['id'],card_id)
        record = self.card_record(row,card_id)
        card = self.board_card(row,card_id)
        external = isinstance(card,dict) and isinstance(card.get('notesLength'),int)
        current_notes = record['notes'] if external else (card.get('notes') if isinstance(card,dict) and isinstance(card.get('notes'),str) else '')
        if op == 'card-read':
            # `external` tells a writer that the board only shows a preview, so an
            # edit must name the version it started from (boardRepository.js).
            return {'status':'ok','notes':current_notes if isinstance(card,dict) else None,
                'notes_version':record['notes_version'],'external':external,'activity':record['activity'],
                'comments':record['comments']}
        if not isinstance(card,dict): fail(404,'card-missing','Card not found.')
        if op == 'comment-write':
            return self.write_comment(row, key, record, card, card_id, body, actor)
        notes, expected = body.get('notes'), body.get('expected_version')
        if not isinstance(notes,str): fail(400,'invalid-notes','A description must be text.')
        if type(expected) is not int or expected < 0: fail(400,'invalid-version','Expected version must be a whole number.')
        if expected != record['notes_version']:
            return {'status':'conflict','notes':current_notes,'notes_version':record['notes_version']}
        if notes == current_notes:
            return {'status':'ok','notes_version':record['notes_version'],'version':row['version'],'card':card}
        # Older descriptions may already be longer (moved out before this cap);
        # they stay editable as long as an edit does not make them longer.
        if len(notes) > MAX_NOTES_CHARS and len(notes) > len(current_notes):
            fail(413,'notes-too-long',f'A description can be at most {MAX_NOTES_CHARS} characters.')
        entries = completion_or_notes(activity_entries(body.get('activity', []), actor, self.stamp()), current_notes, notes)
        record['notes_version'] += 1
        if len(notes) > NOTES_PREVIEW_CHARS:
            record['notes'] = notes
            card['notes'] = notes_preview(notes); card['notesLength'] = len(notes)
        else:
            record['notes'] = None
            card['notes'] = notes; card.pop('notesLength',None)
        self.commit_pieces(row,{'cards':{card_id:card}})
        # The edit's activity is saved with it: both land, or neither does.
        record['activity'] = merge_activity(record['activity'], entries)
        self.store.put('card',key,record)
        return {'status':'ok','notes_version':record['notes_version'],'version':row['version'],'card':card,
                'activity':record['activity']}

    def write_comment(self, row, key, record, card, card_id, body, actor):
        """Append one comment to the card's record, like a description save.

        The writer sends only its own id and the text; the host stamps the
        author, the time and `via` (activity_entries). The board card carries
        the count, so every member's poll sees that the card changed and the
        open card re-reads its details. The matching 'commented' activity
        commits in the same transaction as the comment.
        """
        comment_id = check(body.get('id'), ACTIVITY_ID, 'comment id')
        text = body.get('text')
        if not isinstance(text, str) or not text.strip():
            fail(400, 'invalid-comment', 'A comment must have text.')
        text = text.strip()
        if len(text) > MAX_COMMENT_CHARS:
            fail(413, 'comment-too-long', f'A comment can be at most {MAX_COMMENT_CHARS} characters.')
        existing = next((c for c in record['comments'] if c['id'] == comment_id), None)
        if existing:
            # A replayed save: the first attempt landed, answer it again.
            return {'status': 'ok', 'comment': existing, 'comments': record['comments'],
                    'version': row['version'], 'card': card, 'activity': record['activity']}
        if len(record['comments']) >= MAX_COMMENTS_PER_CARD:
            fail(413, 'comments-full', f'A card can hold up to {MAX_COMMENTS_PER_CARD} comments.')
        comment = {'id': comment_id, 'at': self.stamp(), 'text': text,
                   'by': {'host': actor['host'], 'name': actor.get('name') or actor['host']}}
        if actor.get('via') == 'agent':
            comment['via'] = 'agent'
        record['comments'].append(comment)
        entry = {'id': uuid.uuid4().hex, 'at': comment['at'], 'type': 'commented',
                 'text': text[:MAX_ACTIVITY_TEXT], 'by': comment['by']}
        if 'via' in comment:
            entry['via'] = 'agent'
        card['commentsCount'] = len(record['comments'])
        self.commit_pieces(row, {'cards': {card_id: card}})
        record['activity'] = merge_activity(record['activity'], [entry])
        self.store.put('card', key, record)
        return {'status': 'ok', 'comment': comment, 'comments': record['comments'],
                'version': row['version'], 'card': card, 'activity': record['activity']}

    def patch_activity(self, pieces, raw, actor):
        """Validate the activity a piece save describes, before anything is written.

        `raw` maps a changed card's id to its entries. Only a card the save
        changes and keeps can gain activity, so history only ever accompanies
        a real edit of that card.
        """
        if raw is None: return {}
        if not isinstance(raw, dict):
            fail(400, 'invalid-activity', 'Activity must name the cards this save changes.')
        at, entries = self.stamp(), {}
        for card_id, items in raw.items():
            if not isinstance(pieces['cards'].get(card_id), dict):
                fail(400, 'invalid-activity', 'Activity must name the cards this save changes.')
            entries[card_id] = activity_entries(items, actor, at)
        return entries

    def save_activity(self, row, entries):
        """Merge a committed save's activity into its cards' records; returns each card's activity."""
        saved = {}
        for card_id, items in entries.items():
            key = card_key(row['id'], card_id)
            record = self.card_record(row, card_id)
            record['activity'] = merge_activity(record['activity'], items)
            self.store.put('card', key, record)
            saved[card_id] = record['activity']
        return saved

    def operation(self, row, op, body, actor):
        if op == 'state':
            since = body.get('since_version',-1)
            if type(since) is not int: fail(400,'invalid-version','Version must be an integer.')
            return self.state(row,since,body.get('changes') is True)
        if op in ('card-read','notes-write','comment-write'):
            return self.card_operation(row,op,body,actor)
        if op == 'patch':
            # A newer Kanban sends only the pieces it changed, with the version it
            # started from. It conflicts only when someone else changed one of the
            # same pieces since then; either way the reply brings the writer from
            # its version to the current one.
            pieces = piece_changes(body.get('pieces'))
            expected = body.get('expected_version')
            if type(expected) is not int or not 0 <= expected <= row['version']:
                fail(400,'invalid-version','Expected version must be a version of this board.')
            entries = self.patch_activity(pieces, body.get('activity'), actor)
            if expected < row['log_floor'] or touched_pieces(pieces) & self.touched_since(row,expected):
                return {'status':'conflict',**self.since_reply(row,expected)}
            self.settle_notes(row,pieces['cards'])
            columns = pieces.get('columns', row['columns'])
            entries = {cid: verified_activity(items, self.board_card(row, cid), pieces['cards'][cid],
                                              card_column(row['columns'], cid), card_column(columns, cid))
                       for cid, items in entries.items()}
            self.commit_pieces(row,pieces)
            # The save's activity commits in the same transaction as the save,
            # so a lost reply or a retry can never leave one without the other.
            return {'status':'ok',**self.since_reply(row,expected),'activity':self.save_activity(row,entries)}
        if op == 'write':
            # An older Kanban sends the whole board; it is saved as the pieces it changed.
            doc = board_shape(body.get('doc'))
            expected = body.get('expected_version')
            if type(expected) is not int or expected < 1:
                fail(400,'invalid-version','Expected version must be a positive integer.')
            if expected != row['version']:
                return {'status':'conflict','version':row['version'],'doc':self.board_document(row)}
            pieces = board_difference(self.board_document(row),doc)
            settled = self.settle_notes(row,pieces['cards'])
            self.commit_pieces(row,pieces)
            # Only a document the host changed is sent back; otherwise the writer's copy is exact.
            return {'status':'ok','version':row['version'],**({'doc':self.board_document(row)} if settled else {})}
        aid = check(body.get('asset_id'),ASSET,'asset id')
        key = row['id']+'/'+aid
        if op == 'asset-read':
            asset = self.store.get('asset',key)
            if not asset: fail(404,'asset-missing','Attachment not found.')
            return {'status':'ok','asset':asset}
        if op == 'asset-delete':
            self.store.delete('asset',key)
            return {'status':'deleted'}
        mime,data=body.get('mime'),body.get('data')
        if not isinstance(mime,str) or not re.fullmatch(r'[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+',mime) or len(mime)>120:
            fail(400,'invalid-asset','Invalid attachment type.')
        if not isinstance(data,str) or len(data)>4*((MAX_ASSET+2)//3):
            fail(413,'asset-too-large','Attachment is too large.')
        try: decoded=base64.b64decode(data,validate=True)
        except ValueError: fail(400,'invalid-asset','Invalid attachment encoding.')
        if not decoded or len(decoded)>MAX_ASSET:
            fail(413,'asset-too-large','Attachment is empty or too large.')
        count, total = self.store.usage('asset',row['id']+'/','bytes',excluding=key)
        if count>=MAX_BOARD_FILES or total+len(decoded)>MAX_BOARD_FILE_BYTES:
            fail(413,'assets-full','Board attachment limit reached.')
        self.store.put('asset',key,{'id':aid,'board_id':row['id'],'mime':mime,'data':data,'bytes':len(decoded)})
        return {'status':'ok'}

    async def state_operation(self, host, oid, op, body, *, agent=False):
        """Run a board operation for this deployment's owner. `agent` comes from the
        authenticated caller (agent_request), never from the request body."""
        check(host,HOST,'board host'); check(oid,ID,'board id')
        body = {k:v for k,v in body.items() if k != 'via'}
        actor = {'host':self.host,'name':self.owner_name,'via':'agent' if agent else ''}
        if host == self.host:
            if op in READ_ONLY_OPS:
                with self.store.snapshot():
                    row = self.board(oid)
                    if not self.presence_changes(row['members'][self.host], self.owner_name):
                        return self.operation(row,op,body,actor)
            with self.store.transaction():
                row = self.board(oid)
                changes = self.presence_changes(row['members'][self.host], self.owner_name)
                row['members'][self.host].update(changes)
                result = self.operation(row,op,body,actor)
                if changes or op not in READ_ONLY_OPS:
                    self.store.put('board',oid,row)
                return result
        member = self.store.get('joined',host+'/'+oid)
        if not member or member['status']!='joined':
            fail(409,'membership-unavailable','This board has not been joined or migrated to independent Kanban.')
        try:
            return await self.remote(host,oid,{**body,'op':op,'member_id':member['member_id'],'credential':member['credential'],
                'name':self.owner_name,**({'via':'agent'} if agent else {})})
        except Failure as error:
            if error.code == 'membership-revoked':
                with self.store.transaction():
                    current=self.store.get('joined',host+'/'+oid)
                    if current and current['member_id']==member['member_id']:
                        current['status']='revoked'
                        self.store.put('joined',host+'/'+oid,current)
            raise

    async def handle(self, request):
        try:
            body=request.get('body') or {}
            if not isinstance(body,dict): fail(400,'invalid-request','Request must be an object.')
            path=[unquote(p) for p in str(request.get('path','')).strip('/').split('/') if p]
            method=request.get('method','GET').upper()
            actor=request.get('actor') or {'scope':'public'}
            query=request.get('query') or {}
            def query_value(name,default=None):
                v=query.get(name,default)
                return v[-1] if isinstance(v,list) and v else v
            if path==['health'] and method=='GET':
                result={'status':'ok','service':SERVICE_ID,'host':self.host}
            elif path==['invitations','deliver'] and method=='POST':
                if body.get('protocol')!=PROTOCOL: fail(400,'invalid-protocol','Unsupported collaboration protocol.')
                result=self.receive(body)
            elif len(path)==2 and path[0]=='peer' and method=='POST':
                if body.get('protocol')!=PROTOCOL: fail(400,'invalid-protocol','Unsupported collaboration protocol.')
                result=self.peer(path[1],body)
            else:
                self.owner(actor,write=method!='GET')
                agent=agent_request(actor)
                if not path or path[0]!='boards': fail(404,'route-missing','No such Kanban route.')
                p=path[1:]
                if not p and method=='POST': result=self.new_board(body)
                elif not p and method=='GET':
                    result={'hosted':[self.public(r) for r in self.store.list('board') if not r.get('retired') and not r.get('staged')],
                        'joined':[self.membership(m) for m in self.store.list('joined') if m['status']=='joined']}
                elif p==['join'] and method=='POST': result=await self.join(body)
                elif p==['resume-joins'] and method=='POST':
                    result=await self.resume_join()
                elif p==['invitations'] and method=='GET':
                    result={'invitations':[{k:v for k,v in i.items() if k not in ('invite','declined_tokens')} for i in self.store.list('invitation') if i['status']=='pending']}
                elif len(p)==4 and p[0]=='invitations' and p[3]=='decline' and method=='POST':
                    key=check(p[1],HOST,'host')+'/'+check(p[2],ID,'board id')
                    with self.store.transaction():
                        inv=self.store.get('invitation',key)
                        if inv:
                            _,_,secret=self.parse_invite(inv['invite'])
                            inv.setdefault('declined_tokens',{})[digest(secret)]=self.now()+INVITE_TTL
                            inv['status']='declined'
                            self.store.put('invitation',key,inv)
                            pending=self.store.get('joined',key)
                            if pending and pending.get('status')=='invited':
                                self.store.delete('joined',key)
                    result={'status':'declined'}
                elif len(p)==2 and p[1]=='invites' and method=='POST': result=await self.invite(p[0],body)
                elif len(p)==2 and p[1]=='members' and method=='GET': result=self.public(self.board(p[0]))
                elif len(p)==3 and p[1]=='members' and method=='DELETE':
                    with self.store.transaction():
                        row=self.board(p[0]); mid=p[2]
                        if mid==self.host: fail(400,'owner-removal','The host cannot remove itself.')
                        if mid not in row['members']: fail(404,'member-missing','Member not found.')
                        group=row['members'][mid].get('collaborator_id')
                        removed=[key for key,m in row['members'].items() if key==mid or (query_value('all_deployments')=='true' and group and m.get('collaborator_id')==group)]
                        targets={row['members'][key]['host'] for key in removed}
                        for key in removed:
                            if key==self.host: fail(400,'owner-removal','The host cannot remove itself.')
                            row['members'].pop(key)
                        # Revocation includes still-unredeemed grants to the
                        # removed deployment(s), or the exact registry group.
                        # Otherwise an older invite could silently restore access.
                        all_group=query_value('all_deployments')=='true' and group
                        row['invites']={key:inv for key,inv in row['invites'].items()
                            if inv.get('target') not in targets and not (all_group and inv.get('group')==group)}
                        self.store.put('board',p[0],row)
                    result={'status':'revoked','hosts':removed}
                elif len(p)==1 and method=='DELETE':
                    with self.store.transaction():
                        oid=check(p[0],ID,'board id')
                        existing=self.store.get('board',oid)
                        if existing and existing.get('staged'):
                            fail(409,'migration-staged','The board handoff is not active.')
                        self.store.delete('board',oid)
                        self.store.delete('board-backup',oid)
                        for kind in ('asset','card','board-card','board-change'):
                            self.store.delete_prefix(kind,oid+'/')
                    result={'status':'deleted'}
                elif len(p)==3 and p[2]=='leave' and method=='POST':
                    host,oid=p[:2]; key=check(host,HOST,'host')+'/'+check(oid,ID,'board id')
                    member=self.store.get('joined',key)
                    if member:
                        try: await self.remote(host,oid,{'op':'leave','member_id':member['member_id'],'credential':member['credential']})
                        except Failure as e:
                            if e.code not in ('membership-revoked','board-missing'): raise
                        with self.store.transaction(): self.store.delete('joined',key)
                    result={'status':'left'}
                elif len(p)==3 and p[2]=='state' and method in ('GET','PUT'):
                    if method=='GET':
                        try: body={'since_version':int(query_value('since_version',-1)),'changes':query_value('changes')=='1'}
                        except (ValueError,TypeError): fail(400,'invalid-version','Invalid version.')
                    result=await self.state_operation(p[0],p[1],'state' if method=='GET' else 'write',body,agent=agent)
                elif len(p)==3 and p[2]=='changes' and method=='POST':
                    result=await self.state_operation(p[0],p[1],'patch',body,agent=agent)
                elif len(p)==4 and p[2]=='cards' and method=='GET':
                    result=await self.state_operation(p[0],p[1],'card-read',{'card_id':p[3]},agent=agent)
                elif len(p)==5 and p[2]=='cards' and p[4]=='notes' and method=='PUT':
                    result=await self.state_operation(p[0],p[1],'notes-write',{**body,'card_id':p[3]},agent=agent)
                elif len(p)==5 and p[2]=='cards' and p[4]=='comments' and method=='POST':
                    result=await self.state_operation(p[0],p[1],'comment-write',{**body,'card_id':p[3]},agent=agent)
                elif len(p)==4 and p[2]=='assets' and method in ('GET','PUT','DELETE'):
                    result=await self.state_operation(p[0],p[1],{'GET':'asset-read','PUT':'asset-write','DELETE':'asset-delete'}[method],{**body,'asset_id':p[3]},agent=agent)
                else: fail(404,'route-missing','No such Kanban route.')
            return {'status':200,'body':{'protocol':PROTOCOL,**result},'headers':{'cache-control':'no-store'}}
        except Failure as e:
            return {'status':e.status,'body':{'protocol':PROTOCOL,'code':e.code,'detail':e.message},'headers':{'cache-control':'no-store'}}
