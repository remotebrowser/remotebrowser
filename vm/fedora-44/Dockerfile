# The Fedora 44 guest image for the QEMU browser VMs, with the same services
# as the Debian one: systemd as init, and a headful Chromium on labwc that
# serves CDP on port 9222, while QEMU shows its screen over VNC. The browser
# reaches the internet only through tinyproxy. The services are in
# vm/linux/files, plus what Fedora needs in vm/fedora-44/files.
# vm/build-fedora-44.sh turns this into a disk image; it never runs as a
# container.
FROM fedora:44

# The kernel, systemd, and the guest networking and firewall. The kernel has
# virtio-blk and ext4 built in, so a generic initramfs boots it. The guest
# agent and hwclock set the clock after the host resumes a suspended VM.
RUN dnf install -y --setopt=install_weak_deps=False \
        kernel-core dracut systemd systemd-udev systemd-networkd dbus-broker kmod \
        iproute nftables tinyproxy ca-certificates curl socat gawk nano tzdata \
        qemu-guest-agent util-linux zstd \
    && dnf clean all

# The kernel and an initramfs that boots on any machine, where the unpack
# step looks for them, named as Debian names them. On arm64, vmlinuz is a
# zstd EFI zboot image, which QEMU cannot boot directly (-kernel), so take
# the plain kernel out of it.
RUN kver=$(ls /lib/modules) \
    && kernel=/lib/modules/$kver/vmlinuz \
    && if [ "$(head -c 8 "$kernel" | tail -c 4)" = zimg ]; then \
        [ "$(tail -c +25 "$kernel" | head -c 4)" = zstd ] || { echo 'zboot is not zstd' >&2; exit 1; }; \
        off=$(od -An -t u4 -j 8 -N 4 "$kernel" | tr -d ' '); \
        size=$(od -An -t u4 -j 12 -N 4 "$kernel" | tr -d ' '); \
        tail -c +"$((off + 1))" "$kernel" | head -c "$size" | zstd -dq >"/boot/vmlinuz-$kver"; \
    else \
        cp "$kernel" "/boot/vmlinuz-$kver"; \
    fi \
    && dracut --force --no-hostonly --kver "$kver" "/boot/initrd.img-$kver" \
    && rm -f /boot/initramfs-*

# Pacific time by default, which follows daylight saving (PST and PDT). The
# browser reports this zone to the pages it opens.
RUN ln -sf ../usr/share/zoneinfo/America/Los_Angeles /etc/localtime

# Fedora's Chromium, plus fonts that most sites expect, and labwc on the
# virtual GPU, which sets the screen size and scale live. seatd lets labwc
# open the GPU and the input devices without root. GTK aborts the browser
# without libGLESv2, which Fedora ships apart. The virtual GPU has no 3D, so
# Mesa's llvmpipe (in mesa-dri-drivers) draws GL on the CPU. Fedora's labwc
# does not start without Xwayland, which it runs only when an X app needs it.
RUN dnf install -y --setopt=install_weak_deps=False \
        chromium libglvnd-gles mesa-dri-drivers mesa-libEGL labwc wlr-randr seatd xkeyboard-config \
        xorg-x11-server-Xwayland \
        liberation-fonts dejavu-sans-fonts google-noto-sans-fonts google-noto-sans-cjk-fonts \
        google-noto-color-emoji-fonts \
    && dnf clean all \
    # chromium.service runs it under Debian's name.
    && ln -s chromium-browser /usr/bin/chromium

# The browser runs as this user, so its own sandbox stays on.
RUN useradd --create-home --shell /usr/sbin/nologin browser

COPY linux/files/ /
COPY fedora-44/files/ /

# Chromium is not enabled: chromium-start.timer starts it, once a VM starts
# from the snapshot.
RUN systemctl enable systemd-networkd nftables tinyproxy tinyproxy-upstream.path \
        screen-resolution.path screen-scale.path seatd display cdp-proxy guest-ready \
        chromium-start.timer \
    # Nothing in the VM needs these, and each one slows the boot.
    && systemctl mask systemd-networkd-wait-online dnf-makecache.timer getty@tty1 \
    # Fedora's nftables reads its rules from here.
    && ln -sf ../nftables.conf /etc/sysconfig/nftables.conf \
    # A random machine id per boot, instead of one baked into the image.
    && truncate -s 0 /etc/machine-id \
    # The upstream proxy may hold a password, which the browser must not read.
    && install -d -m 0700 /etc/remotebrowser/proxy
