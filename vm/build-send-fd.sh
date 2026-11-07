#!/bin/sh
# Only warns without a C compiler, as just reading the mouse pointer needs send-fd.
cd "$(dirname "$0")" || exit 1
cc=${CC:-cc}
if ! command -v "$cc" >/dev/null 2>&1; then
  echo "WARNING: no C compiler ($cc), so vm/send-fd is not built, and the API cannot read where the mouse pointer is" >&2
  exit 0
fi
echo "Building vm/send-fd with $cc..."
if "$cc" -O2 -Wall -Wextra -o send-fd send-fd.c; then
  echo "Built vm/send-fd"
else
  echo "ERROR: unable to build vm/send-fd with $cc" >&2
  exit 1
fi
