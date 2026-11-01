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
# but see WHERE THE JOIN BREAKS before trusting the join on anything but one
# serialised bridge.
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
# WHERE THE JOIN BREAKS - read before using it on another host:
#   `join` pairs each send with the FIRST `op:'reply'` audit entry at or after
#   that send's acceptance. That holds only while turns are serialised on ONE
#   bridge - one reply in flight at a time - which is the case for every turn
#   this lane measured. With concurrent bridges, or two turns in flight on one
#   bridge, it can pair a send with another turn's reply. Pair on messageId
#   instead (the `turn <id> from ...` host line and the audit's messageId) and
#   do not quote the output until that is done.
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


def stamp(text):
    return datetime.datetime.strptime(text, '%Y-%m-%dT%H:%M:%S.%fZ')


# One send is: a `phase send click_begin` line (its timestamp is the click
# start) followed by that send's `click post:` line, whose offset is measured
# from click_begin and whose timestamp is the acceptance verdict.
sends = []
begin = None
for line in open(log_path, encoding='utf-8'):
    match = re.match(r'^(\S+Z) phase send click_begin (\d+)ms', line)
    if match:
        begin = stamp(match.group(1))
        continue
    match = re.match(r'^(\S+Z) click post: the send POST was seen (\d+)ms after click_begin', line)
    if match and begin is not None:
        posted = begin + datetime.timedelta(milliseconds=int(match.group(2)))
        sends.append((posted, stamp(match.group(1))))
        begin = None

replies = [
    (stamp(entry['at']), entry.get('messageId', ''))
    for entry in json.load(open(peer_path, encoding='utf-8')).get('audit', [])
    if entry.get('op') == 'reply'
]

print('%-14s %-14s %-14s %11s %13s  %s' % ('POST', 'accept', 'reply', 'POST->reply', 'accept->reply', 'message'))
rows = 0
for posted, accepted in sends:
    if cut and posted.strftime('%Y-%m-%dT%H:%M:%S') < cut:
        continue
    hit = next(((at, message) for at, message in replies if at >= accepted), None)
    if hit is None:
        print('%-14s %-14s %-14s %11s %13s  %s' % (
            posted.strftime('%H:%M:%S.%f')[:-3], accepted.strftime('%H:%M:%S.%f')[:-3],
            '-', '-', '-', '(no reply audit after this acceptance)'))
        continue
    at, message = hit
    rows += 1
    print('%-14s %-14s %-14s %10.3fs %12.3fs  %s' % (
        posted.strftime('%H:%M:%S.%f')[:-3], accepted.strftime('%H:%M:%S.%f')[:-3],
        at.strftime('%H:%M:%S.%f')[:-3], (at - posted).total_seconds(), (at - accepted).total_seconds(),
        message))

if rows == 0:
    print('reply-split: no send/reply pair at or after %s' % (cut or 'the start of the log'), file=sys.stderr)
PY
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    ;;
esac
