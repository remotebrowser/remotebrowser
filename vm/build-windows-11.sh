#!/bin/sh
# Installs the Windows 11 image and saves its snapshot; see docs/vm.md.
set -eu

exec "$(dirname "$0")/scripts/build.js" windows-11
