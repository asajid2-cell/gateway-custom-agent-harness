#!/usr/bin/env bash
# chatgpt-peer-reply-split - the send/reply timing split, from the live artifacts.
#
# Two cuts, kept in one file because they are always read together:
#
#   split [SINCE]  every `acceptance in <ms>ms` and `reply in <ms>ms` line at or
#                  after SINCE, as TSV: timestamp, kind, ms, rest
#   join  [SINCE]  the headline column: page POST -> host delivery, pairing each
#                  send with the reply audit entry that answers it
#
# Usage:
#   scripts/chatgpt-peer-reply-split.sh split 2026-11-01T09:42:39
#   scripts/chatgpt-peer-reply-split.sh join  2026-11-01T09:42:39
#   scripts/chatgpt-peer-reply-split.sh split          # no window: whole file
#
# Paths, overridable by environment:
#   CHATGPT_DRIVER_LOG  default ~/.chatgpt-web/driver.log   (the child's log)
#   CHATGPT_PEER_JSON   default ~/chatgpt-web/peer.json     (the host's audit)
#   PYTHON              default python
#
# Read-only. Neither artifact is ever written: `split` pipes the log through
# awk/grep/sed, `join` reads both files. Windows are cut on the ISO timestamp at
# the head of every line, so a shared or still-growing log is safe to point at -
# but see WHAT THE JOIN CANNOT KNOW before trusting the join on anything but
# one serialised bridge.
#
# METHOD - the arithmetic that failed by hand once, so it lives here only:
#   the page's own send POST time is the `phase send click_begin` line timestamp
#   PLUS the `after click_begin` offset printed on that send's `click post:`
#   line. Never add that offset to `click_end`: it is measured from click_begin,
#   so click_end double-counts the click dispatch (1.4-2.4 s) and every POST -> X
#   duration comes out short. (G-016, 2026-11-01: the first POST -> reply column
#   was reported 12.8-13.6 s / 10.7-13.3 s when it is 14.61-16.53 s before and
#   13.10-15.10 s after, because of exactly this.)
#
# EVERY SEND GETS A ROW. `join` defines a send by its `click_begin` line, so it
# prints a row for every one - including the sends whose POST was never stamped,
# which an earlier version of this file dropped in silence:
#
#   `click post: the send POST was seen <n>ms after click_begin`
#       POST = click_begin + n. The ordinary shape.
#   `click post: no send POST was observed before acceptance`
#       the page's own hook saw nothing, but the CDP viewer often did: fall back
#       to `click network: the CDP session saw POST /backend-api/f/conversation
#       at <n>ms after click_begin`. The two can differ by a millisecond or so -
#       they are separate observers of the same request - so the CDP stamp is
#       used only as a fill-in and the row says so. No network line either, and
#       POST prints `-`.
#   `click_begin` with no `click post:` line at all
#       the click phase never reported a verdict: the send predates the
#       click-post probe, or it never finished. POST prints `-`, and the
#       acceptance is paired from the first `acceptance in` line after that
#       click_begin and before the next one, with the note saying it was paired
#       this way. These sends are not discarded - they are exactly what a
#       POST -> reply column exists to explain.
#
# THE DENOMINATOR IS NOT `split`'s COUNT. `split` prints every `acceptance in`
# line in the window; `join` prints one row per `click_begin`. They differ (30
# against 13 over the whole 2026-11-01 log) because sends with no click phase in
# this file accept too - the proof rigs share the same log. `join` therefore ends
# with a denominator line breaking down the click_begin count and giving the
# acceptance count separately, so a row count is never read as a turn count.
#
# REPLY PAIRING IS BOUNDED. A reply is paired only when it lands within the
# child's send budget - SEND_TIMEOUT_MS = 240_000 (chatgpt.mjs:82, deployed
# child). A later reply cannot be this send's answer, because the send has
# already failed; the row prints `-` and says so. Without the bound a quiet
# stretch makes a later turn's reply look like a four-minute POST -> reply.
#
# WHAT THE JOIN CANNOT KNOW - read before using it on another host:
#   `join` pairs each send with the FIRST `op:'reply'` audit entry at or after
#   that send's acceptance, inside the budget. That holds only while turns are
#   serialised on ONE bridge - one reply in flight at a time - which is the case
#   for every turn this lane measured. With concurrent bridges, or two turns in
#   flight on one bridge, it can pair a send with another turn's reply; when two
#   rows land on the same reply the note says so, but the pairing is still not
#   trustworthy. Pair on messageId instead (the `turn <id> from ...` host line
#   and the audit's messageId) and do not quote the output until that is done.
#
# The delivery instant is the audit `op:'reply'` timestamp, not the host stderr
# `delivered answer ... in Ns` line: that line carries only postedAt plus a
# rounded elapsed, and the host log has no timestamps at all.

set -euo pipefail

LOG="${CHATGPT_DRIVER_LOG:-$HOME/.chatgpt-web/driver.log}"
PEER="${CHATGPT_PEER_JSON:-$HOME/chatgpt-web/peer.json}"
PYTHON="${PYTHON:-python}"

usage() {
  sed -n '/^# Usage:/,/^# Paths, overridable/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d' >&2
  exit 2
}

mode="${1:-}"
cut="${2:-}"

[ -n "$mode" ] || usage
[ -r "$LOG" ] || { echo "reply-split: cannot read $LOG" >&2; exit 1; }

case "$mode" in
  split)
    # Window first, then the two line kinds. `acceptance in` and `reply in` are
    # both `<ISO> <kind> in <ms>ms: <rest>`, and `rest` may or may not carry the
    # stability clause (`text stable for <ms>ms, <k> agreeing samples`) - the cut
    # does not care which.
    awk -v c="$cut" '$0 >= c' "$LOG" \
      | grep -E '^[0-9T:.+-]+Z (acceptance|reply) in [0-9]+ms' \
      | sed -E 's/^(\S+Z) (acceptance|reply) in ([0-9]+)ms:?[ ]?(.*)$/\1\t\2\t\3\t\4/' \
      || true
    ;;
  join)
    "$PYTHON" - "$LOG" "$PEER" "$cut" <<'PY'
import datetime
import json
import re
import sys

log_path, peer_path, cut = sys.argv[1], sys.argv[2], sys.argv[3]

# The child's own send budget (SEND_TIMEOUT_MS, chatgpt.mjs:82). A reply after
# this cannot answer the send; see REPLY PAIRING IS BOUNDED in the header.
SEND_BUDGET = datetime.timedelta(seconds=240)

BEGIN = re.compile(r'^(\S+Z) phase send click_begin (\d+)ms')
POST_SEEN = re.compile(r'^(\S+Z) click post: the send POST was seen (\d+)ms after click_begin')
POST_NONE = re.compile(r'^(\S+Z) click post: no send POST was observed')
NETWORK = re.compile(r'^(\S+Z) click network: the CDP session saw POST /backend-api/f/conversation at (\d+)ms after click_begin')
ACCEPT = re.compile(r'^(\S+Z) acceptance in (\d+)ms: (.*)$')


def stamp(text):
    return datetime.datetime.strptime(text, '%Y-%m-%dT%H:%M:%S.%fZ')


begins = []           # (index, at)
posts = {}            # index -> (at, offset)  for a `was seen` line
nones = {}            # index -> at               for a `no send POST` line
networks = {}         # index -> (at, offset)
accepts = []          # (index, at, path)

with open(log_path, encoding='utf-8') as handle:
    for index, line in enumerate(handle):
        match = BEGIN.match(line)
        if match:
            begins.append((index, stamp(match.group(1))))
            continue
        match = POST_SEEN.match(line)
        if match:
            posts[index] = (stamp(match.group(1)), int(match.group(2)))
            continue
        match = POST_NONE.match(line)
        if match:
            nones[index] = stamp(match.group(1))
            continue
        match = NETWORK.match(line)
        if match:
            networks[index] = (stamp(match.group(1)), int(match.group(2)))
            continue
        match = ACCEPT.match(line)
        if match:
            accepts.append((index, stamp(match.group(1)), match.group(3)))

# Each send owns the log between its click_begin and the next click_begin.
sends = []
for order, (index, begin_at) in enumerate(begins):
    stop = begins[order + 1][0] if order + 1 < len(begins) else None

    def owned(table):
        for key in table:
            if key > index and (stop is None or key < stop):
                return key
        return None

    post_key = owned(posts)
    none_key = owned(nones)
    network_key = owned(networks)

    post_at, post_src, note = None, None, ''
    if post_key is not None:
        post_at = begin_at + datetime.timedelta(milliseconds=posts[post_key][1])
        post_src = 'page'
    elif network_key is not None:
        post_at = begin_at + datetime.timedelta(milliseconds=networks[network_key][1])
        post_src = 'cdp'
        note = 'POST from the CDP line; the page hook saw none'
    elif none_key is not None:
        note = 'no POST seen at the page or over CDP'
    else:
        note = 'no click post: line; acceptance paired from the next acceptance line'

    accepted = None
    for accept_index, accept_at, path in accepts:
        if accept_index > index and (stop is None or accept_index < stop):
            accepted = accept_at
            break
    if accepted is None:
        note = (note + '; ' if note else '') + 'no acceptance line in this send'

    sends.append({
        'begin': begin_at, 'post': post_at, 'post_src': post_src,
        'accepted': accepted, 'accept_note': note,
    })

replies = [
    (stamp(entry['at']), entry.get('messageId', ''))
    for entry in json.load(open(peer_path, encoding='utf-8')).get('audit', [])
    if entry.get('op') == 'reply'
]

def fmt(when):
    return '-' if when is None else when.strftime('%H:%M:%S.%f')[:-3]

def dur(delta):
    return '%10s' % '-' if delta is None else '%10.3fs' % delta.total_seconds()

rows = []
for send in sends:
    anchor = send['post'] or send['begin']
    if cut and anchor.strftime('%Y-%m-%dT%H:%M:%S') < cut:
        continue

    note = send['accept_note']
    reply_at = reply_message = None
    if send['accepted'] is None:
        pass
    else:
        hit = next(
            ((at, message) for at, message in replies
             if send['accepted'] <= at <= send['accepted'] + SEND_BUDGET),
            None,
        )
        if hit is None:
            note = (note + '; ' if note else '') + 'no reply audit inside the 240 s send budget'
        else:
            reply_at, reply_message = hit

    rows.append((send, reply_at, reply_message, note))

claimed = {}
for send, reply_at, _, _ in rows:
    if reply_at is not None:
        claimed[reply_at] = claimed.get(reply_at, 0) + 1

print('%-14s %-14s %-14s %11s %13s  %s' % (
    'POST', 'accept', 'reply', 'POST->reply', 'accept->reply', 'message  [note]'))
for send, reply_at, reply_message, note in rows:
    if reply_at is not None and claimed[reply_at] > 1:
        note = (note + '; ' if note else '') + 'same reply claimed by another send - pair on messageId'
    posted, accepted = send['post'], send['accepted']
    print('%-14s %-14s %-14s %s %s  %s%s' % (
        fmt(posted), fmt(accepted), fmt(reply_at),
        dur((reply_at - posted) if (posted and reply_at) else None),
        dur((reply_at - accepted) if (accepted and reply_at) else None),
        reply_message or '-',
        ('  [' + note + ']') if note else '',
    ))

if not rows:
    print('reply-split: no click_begin at or after %s' % (cut or 'the start of the log'), file=sys.stderr)
    sys.exit(0)

windowed = [send for send in sends if not cut or (send['post'] or send['begin']).strftime('%Y-%m-%dT%H:%M:%S') >= cut]
page = sum(1 for send in windowed if send['post_src'] == 'page')
cdp = sum(1 for send in windowed if send['post_src'] == 'cdp')
nopost = sum(1 for send in windowed if send['post'] is None and send['accept_note'].startswith('no POST'))
noline = sum(1 for send in windowed if send['post'] is None and send['accept_note'].startswith('no click post'))
accept_count = sum(1 for _, at, _ in accepts if not cut or at.strftime('%Y-%m-%dT%H:%M:%S') >= cut)
paired = sum(1 for _, reply_at, _, _ in rows if reply_at is not None)

print()
print(
    'reply-split: %d click_begin = %d page POST + %d CDP-only POST + %d no POST + %d no click post: line; '
    '%d acceptance lines in the same window (not a join denominator - sends with no click phase '
    'in this file accept too); %d row(s), %d paired with a reply inside the 240 s send budget, %d unpaired.'
    % (len(windowed), page, cdp, nopost, noline, accept_count, len(rows), paired, len(rows) - paired))
PY
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    ;;
esac
