#!/bin/sh
# Builds the Debian 13 image and its snapshot; see docs/sandboxing.md.
set -eu

exec "$(dirname "$0")/scripts/build.js" debian-13
