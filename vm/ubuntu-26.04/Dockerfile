# The Ubuntu 26.04 LTS guest image for the QEMU browser VMs, with the same
# services as the Debian one: systemd as init, and a headful Chromium on labwc
# that serves CDP on port 9222, while QEMU shows its screen over VNC. The
# browser reaches the internet only through tinyproxy. The services are in
# vm/linux/files, plus what Ubuntu needs in vm/ubuntu-26.04/files.
# vm/build-ubuntu-26.04.sh turns this into a disk image; it never runs as a
# container.
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

# The kernel, systemd, and the guest networking and firewall. The virtual
# kernel is the one built for running in a VM. The guest agent and hwclock
# set the clock after the host resumes a suspended VM.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        linux-image-virtual initramfs-tools \
        systemd systemd-sysv dbus kmod udev \
        iproute2 nftables tinyproxy ca-certificates curl socat nano tzdata \
        qemu-guest-agent util-linux-extra \
    && rm -rf /var/lib/apt/lists/*

# Pacific time by default, which follows daylight saving (PST and PDT). The
# browser reports this zone to the pages it opens.
RUN ln -sf /usr/share/zoneinfo/America/Los_Angeles /etc/localtime \
    && echo America/Los_Angeles >/etc/timezone

# Chromium from the xtradeb PPA, as Ubuntu's own is a snap; see the files in
# etc/apt. Plus fonts that most sites expect, and labwc on the virtual GPU,
# which sets the screen size and scale live. seatd lets labwc open the GPU
# and the input devices without root.
COPY ubuntu-26.04/files/etc/apt/ /etc/apt/
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium labwc wlr-randr seatd xkb-data \
        fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# The browser runs as this user, so its own sandbox stays on.
RUN useradd --create-home --shell /usr/sbin/nologin browser

COPY linux/files/ /
COPY ubuntu-26.04/files/ /

# Chromium is not enabled: chromium-start.timer starts it, once a VM starts
# from the snapshot.
RUN systemctl enable systemd-networkd nftables tinyproxy tinyproxy-upstream.path \
        screen-resolution.path screen-scale.path seatd display cdp-proxy guest-ready \
        chromium-start.timer \
    # Nothing in the VM needs these, and each one slows the boot.
    && systemctl mask systemd-networkd-wait-online apt-daily.timer apt-daily-upgrade.timer \
        motd-news.timer e2scrub_reap getty@tty1 \
    # A random machine id per boot, instead of one baked into the image.
    && truncate -s 0 /etc/machine-id \
    # The upstream proxy may hold a password, which the browser must not read.
    && install -d -m 0700 /etc/remotebrowser/proxy
