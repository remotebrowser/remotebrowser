#!/bin/sh
# Builds the image and snapshot of each guest OS, all at once. Windows 11 is
# left out until its install ISO is in place; see docs/vm.md.
set -eu

dir=$(dirname "$0")
iso="${VM_DATA_DIR:-$dir/../.data/vm}/iso/windows-11.iso"

"$dir/build-debian-13.sh" &
debian=$!
"$dir/build-ubuntu-26.04.sh" &
ubuntu=$!
"$dir/build-fedora-44.sh" &
fedora=$!
windows=
if [ -e "$iso" ]; then
  "$dir/build-windows-11.sh" &
  windows=$!
else
  echo "Skipping Windows 11: no install ISO at $iso"
fi

status=0
wait "$debian" || status=1
wait "$ubuntu" || status=1
wait "$fedora" || status=1
if [ -n "$windows" ]; then
  wait "$windows" || status=1
fi
exit "$status"
