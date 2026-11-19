#!/bin/sh
# Install qq-bot: link the repo's src/qq-bot.ts as ~/.local/bin/qq-bot
# and copy the keepalive helper. Run from the repo root.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexec node %s/src/qq-bot.ts "$@"\n' "$REPO" > "$HOME/.local/bin/qq-bot"
chmod +x "$HOME/.local/bin/qq-bot"
cp "$REPO/adapters/muse/qq-bot-keepalive" "$HOME/.local/bin/qq-bot-keepalive"
chmod +x "$HOME/.local/bin/qq-bot-keepalive"
echo "installed: $HOME/.local/bin/qq-bot (repo: $REPO)"
"$HOME/.local/bin/qq-bot" version
