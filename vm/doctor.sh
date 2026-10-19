#!/bin/sh
# Check that this host can run the browser VMs. QEMU and hardware
# virtualization (KVM on Linux, HVF on macOS) are required; without zstd,
# suspended VMs only take more disk space.

fatal() {
  echo "ERROR: $1" >&2
  exit 1
}

warn() {
  echo "WARNING: $1" >&2
}

ok() {
  echo "OK: $1"
}

# The VMs run on the host's own architecture, so KVM or HVF can run them natively.
arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) qemu=qemu-system-x86_64 ;;
  aarch64 | arm64) qemu=qemu-system-aarch64 ;;
  *) fatal "unsupported architecture: $arch" ;;
esac

command -v "$qemu" >/dev/null 2>&1 || fatal "$qemu is not installed"
version=$("$qemu" --version 2>/dev/null | head -n 1) || fatal "$qemu does not run"
[ -n "$version" ] || fatal "$qemu does not run"
ok "$version"

# The server creates each VM's disk overlay with qemu-img.
command -v qemu-img >/dev/null 2>&1 || fatal "qemu-img is not installed"

# Suspended VMs keep their memory state compressed with zstd.
if command -v zstd >/dev/null 2>&1; then
  ok "$(zstd --version)"
else
  warn "zstd is not installed, so the state of suspended VMs stays uncompressed"
fi

if [ "$(uname -s)" = Darwin ]; then
  [ "$(sysctl -n kern.hv_support 2>/dev/null)" = 1 ] ||
    fatal "macOS has no Hypervisor.framework here, and the VMs are too slow without it"
  # macOS lets only a binary signed with this entitlement use HVF.
  codesign -d --entitlements - "$(command -v "$qemu")" 2>/dev/null | grep -q com.apple.security.hypervisor ||
    fatal "$qemu is not signed for Hypervisor.framework (it needs the com.apple.security.hypervisor entitlement)"
  ok "HVF is available"
elif [ ! -e /dev/kvm ]; then
  fatal "/dev/kvm does not exist, and the VMs are too slow without KVM"
elif [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  fatal "$(id -un) cannot open /dev/kvm (add the user to the kvm group)"
else
  ok "KVM is available"
fi
