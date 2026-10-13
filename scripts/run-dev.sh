#!/bin/sh
cd "$(dirname "$0")/.." || exit 1
. "$HOME/.cargo/env"
export LD_LIBRARY_PATH="$PWD/src-tauri/resources/instantclient:$LD_LIBRARY_PATH"
exec npm run tauri dev
