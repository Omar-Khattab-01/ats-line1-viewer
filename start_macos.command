#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Install Python 3.10 or newer from https://www.python.org/downloads/"
  read -r REPLY
  exit 1
fi
python3 -m ats_viewer --open "$@"
