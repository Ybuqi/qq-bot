#!/usr/bin/env bash
# Muse hook detector for qq-bot pull delivery (binding muse).
# Mirrors wx-bot-wechat.sh: count first, wake on new events, health check
# with keepalive-first recovery, 60-min alert suppression, dry runs touch
# no state.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

QQBOT="${QQBOT:-$HOME/.local/bin/qq-bot}"
BINDING="${QQBOT_BINDING:-muse}"
MARK="$HOME/hooks/state/qq-bot-alerted"
DRY="${HATCH_HOOK_DRY_RUN:-0}"

if ! count_raw="$("$QQBOT" inbox count --binding "$BINDING" 2>&1)"; then
  log "qq-bot inbox count failed" "{\"error\": $(printf '%s' "$count_raw" | jq -Rs .)}"
  silent "qq-bot count failed"
fi
count="$(printf '%s' "$count_raw" | awk '{print $1}')"

if [ "$count" -gt 0 ]; then
  wake "QQ 有 $count 条新事件" "{\"count\": $count}"
fi

if health="$("$QQBOT" health --binding "$BINDING" --liveness 2>&1)"; then
  if [ "$DRY" != "1" ]; then rm -f "$MARK"; fi
  silent "no new events, qq-bot healthy"
fi

if [ -f "$MARK" ] && [ -z "$(find "$MARK" -mmin +60 2>/dev/null)" ]; then
  silent "qq-bot unhealthy, already alerted within 60m"
fi

ka=""
if [ "$DRY" != "1" ] && [ -x "${HOME}/.local/bin/qq-bot-keepalive" ]; then
  ka="$("${HOME}/.local/bin/qq-bot-keepalive" 2>&1 || true)"
fi

if [ "$DRY" != "1" ]; then
  mkdir -p "$(dirname "$MARK")"
  touch "$MARK"
fi

if [ -n "$ka" ]; then
  wake "qq-bot 异常：$health；keepalive: $ka" "{\"health\": $(printf '%s' "$health" | jq -Rs .), \"keepalive\": $(printf '%s' "$ka" | jq -Rs .)}"
else
  wake "qq-bot 异常：$health" "{\"health\": $(printf '%s' "$health" | jq -Rs .)}"
fi
