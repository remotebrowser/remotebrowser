# VM

Each browser runs in its own virtual machine (VM). This page describes what is inside the VM of each guest OS. See [Sandboxing](sandboxing.md) for how the app prepares each OS and runs its VMs.

The launch page, and the [API](api.md), offer an OS once its snapshot is ready. Debian 13 is the default.

## Linux

Debian 13 (`debian-13`), Ubuntu 26.04 (`ubuntu-26.04`), and Fedora 44 (`fedora-44`) share one design. Each is a small system with systemd, and runs Chromium or Google Chrome.

### Image

The app builds the image of each Linux OS from its Dockerfile with Docker, such as `vm/debian-13/Dockerfile`. It copies in the services from `vm/linux/files`, and an OS may add its own in `vm/<os>/files`. Docker only installs the packages; the result never runs as a container. The image is a qcow2 disk, with its kernel and initrd, which QEMU boots directly.

- Ubuntu ships Chromium only as a snap, which does not install in a Docker build. So its image takes Chromium, and nothing else, from the [xtradeb PPA](https://launchpad.net/~xtradeb/+archive/ubuntu/apps), with the signing key in `vm/ubuntu-26.04/files/etc/apt`.
- Fedora's tinyproxy unit takes no flags, so its image adds a drop-in in `vm/fedora-44/files`.
- Each image also has Google Chrome, from Google's own repository.

To change what runs in the VMs, edit the files in `vm/linux/files`, or an OS's own Dockerfile. The app builds the images again at its next start.

### Services

The services are all in `vm/linux/files`:

| Service            | What it does                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `systemd-networkd` | Gets the guest address from QEMU user-mode networking by DHCP (`10.0.2.15`, gateway `10.0.2.2`, DNS `10.0.2.3`)                                                      |
| `nftables`         | Refuses new connections to `10.0.2.2`, which leads to the host's loopback interface                                                                                  |
| `tinyproxy`        | The HTTP proxy that all of the browser's traffic goes through, on `127.0.0.1:8119`. See [Proxy](proxy.md#linux)                                                      |
| `seatd`            | Opens the GPU and the input devices for labwc, so labwc needs no root                                                                                                |
| `display`          | [labwc](https://labwc.github.io), a Wayland compositor, on the VM's virtual GPU, which QEMU shows over VNC. It runs as the `browser` user. See [Display](display.md) |
| `chromium`         | The distro's Chromium, or Google Chrome, on that display, as the unprivileged `browser` user, with CDP on `127.0.0.1:9221`                                           |
| `chromium-start`   | A timer that starts `chromium` when the host sets the clock, after a VM starts from the snapshot                                                                     |
| `guest-ready`      | Writes `remotebrowser: guest ready` to the console once the others are up, so the host can save the snapshot                                                         |
| `cdp-proxy`        | Exposes CDP on port `9222` of the guest address, which is where QEMU forwards the host port                                                                          |

### Browser

The browser has a display rather than running headless. It reads its flags from `/etc/remotebrowser/browser.env`, which points it at tinyproxy. The VM has no GPU, so WebGL is off, unless the host enables it at launch. Then the app writes `/etc/remotebrowser/webgl.env`, and the browser renders WebGL on the CPU. WebGPU is not available.

Each image has every browser that it offers, and the snapshot runs none of them, so one snapshot serves them all. At launch, before it sets the clock, the app writes the binary of the browser that was picked into `/etc/remotebrowser/app.env`, and `/usr/local/bin/browser` runs it, else Chromium. The browser does not start without `nftables` and `tinyproxy`.

### Isolation

- The browser runs as an unprivileged user, so its own sandbox stays on.
- The QEMU guest agent accepts only the commands that set the clock and write the files that the host sets, such as the proxy and the screen size.
- `nftables` blocks `10.0.2.2`, so a browser cannot reach services on the host's loopback, such as the app or its database.

### Check a VM

`vm/scripts/run.js debian-13` starts a VM from the snapshot, with a root shell on your terminal (see [Manual test](sandboxing.md#manual-test)). There, look at the services:

```bash
systemctl status chromium cdp-proxy tinyproxy nftables
journalctl -u chromium
```

## Windows

Windows 11 (`windows-11`) runs Microsoft Edge, which comes with Windows. A launch may pick Chromium or Google Chrome, and it succeeds, but the VM runs Edge either way.

### What you need

- An x86_64 Linux host with KVM. Without KVM, the install takes many hours.
- A Windows 11 install ISO, in English (United States), at `iso/windows-11.iso` in the [data directory](sandboxing.md#data-directory), which is `.data/vm/iso/windows-11.iso` by default. Get it from Microsoft's Windows 11 download page: under "Download Windows 11 Disk Image (ISO)", pick the x64 edition and English (United States), and rename the file to `windows-11.iso`. `vm/windows-11/autounattend.xml` picks `en-US`, and Setup stops to ask if the ISO does not have it. Windows is not free to redistribute, so Remote Browser does not download it. You are responsible for the Windows license.
- `xorriso`, `genisoimage`, or `mkisofs`. The container image has `xorriso`.
- At least `4G` of memory per VM, which is the default of `VM_MEMORY`.

The first time, the app downloads two more files to `iso/`:

- The [virtio-win ISO](https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso), as `virtio-win.iso`. It has the drivers and the QEMU guest agent. To use another version, put it there yourself.
- The [3proxy](https://3proxy.org) zip, `3proxy-1.0.2-x64.zip`, which the guest uses as its local proxy.

Setup picks the edition with the generic Windows 11 Pro key, which does not activate Windows.

### Image

The Windows image needs no Docker. The app installs Windows instead:

1. It makes a small unattend CD from `vm/windows-11`: `autounattend.xml` for Windows Setup, the scripts that run in the guest, and the 3proxy zip, with a random password for the `browser` account.
2. QEMU boots the Windows ISO with the virtio-win ISO and the unattend CD. Setup installs Windows with no questions asked, and reboots a few times. While it runs, the app logs a VNC address on `127.0.0.1` where you can watch it.
3. At the end of Setup, Windows runs `remotebrowser-setup.ps1` as SYSTEM. It installs the drivers, the guest agent, and 3proxy, sets up the tasks below, the CDP port, and the Edge policies, turns off sleep and automatic updates, and shuts Windows down.
4. The disk goes to `images/windows-11/x86_64-<hash>` in the data directory. A change to the ISOs, the 3proxy zip, or `vm/windows-11` means a new install.

The install takes 10 to 30 minutes with KVM. Then the app saves the snapshot in `snapshots/windows-11`: it boots the image until the `browser` account has logged in and the screen is 1920×1080, and saves the running VM. `guest-ready.ps1` writes `remotebrowser: guest ready` to the serial console when it is.

At startup, the app builds the Windows 11 image when the ISO is in place, at the same time as the other OSes. Or build it ahead of time with `vm/build-windows-11.sh`. It needs no Docker socket:

```bash
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  --device /dev/kvm \
  --group-add "$(stat -c '%g' /dev/kvm)" \
  -v "$PWD/.data/vm:/app/.data/vm" \
  ghcr.io/remotebrowser/remotebrowser vm/build-windows-11.sh
```

`vm/build-image.sh` runs it too, when `iso/windows-11.iso` is there.

### Hardware

The VM boots through the BIOS from an AHCI disk, which Setup needs no driver for. Its NIC is an e1000e, its screen a `virtio-vga`, which Setup can use as a plain VGA, and its pointer a USB tablet. QEMU user-mode networking gives it the address `10.0.2.15`, with the gateway `10.0.2.2`.

### Tasks

Windows logs in the `browser` account by itself at each boot. That account is not an administrator. These tasks run at logon, from `C:\Program Files\remotebrowser`:

| Task                              | Runs as            | What it does                                                                                                   |
| --------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `remotebrowser-browser`           | The `browser` user | Starts Edge when the host says so, and again whenever it exits (`browser.ps1`)                                 |
| `remotebrowser-proxy`             | SYSTEM             | Writes the config of 3proxy from the proxy that the host sets (`proxy.ps1`). See [Proxy](proxy.md#windows)     |
| `remotebrowser-screen-resolution` | The `browser` user | Sets the screen size that the host sets (`screen-resolution.ps1`). See [Display](display.md#screen-resolution) |
| `remotebrowser-screen-scale`      | The `browser` user | Sets the screen scale that the host sets (`screen-scale.ps1`). See [Display](display.md#screen-scale)          |
| `remotebrowser-guest-ready`       | SYSTEM             | Tells the host that the guest is ready, so it can save the snapshot (`guest-ready.ps1`)                        |

The host writes its settings into `C:\ProgramData\remotebrowser` through the guest agent. Users may read that directory, but not change it.

### Browser

Edge is not in the snapshot, so that VMs do not share its random number state. At launch, the host sets the guest clock, then writes `C:\ProgramData\remotebrowser\start-browser`. `browser.ps1` waits for that file, and for `proxy.ps1` to set 3proxy to the proxy that the host asked for, so even the first request takes that route. Then it closes the Start menu, which Windows opens at the first logon, and starts Edge, maximized, with its own profile in the `browser` account. The host waits until CDP answers.

Edge runs with these flags, among others:

- `--remote-debugging-port=9221`, for CDP on `127.0.0.1:9221`.
- `--proxy-server=http://127.0.0.1:8119`, for 3proxy.
- `--no-first-run`, `--no-default-browser-check`, `--disable-sync`, and `--disable-background-networking`.
- `--ignore-gpu-blocklist`, when the host enables WebGL. The VM has no GPU, so Edge then renders WebGL on the CPU.

Edge listens for CDP on `127.0.0.1` only. A port proxy (`netsh interface portproxy`) exposes it on port `9222` of the guest address, which is where QEMU forwards the host port, and a firewall rule lets it in. Policies in `HKLM\SOFTWARE\Policies\Microsoft\Edge` keep Edge from asking questions on its first run, offering to translate a page, running in the background, or offering to sign in. Policies in `HKLM\SOFTWARE\Policies\Microsoft\EdgeUpdate` keep it from updating itself.

Edge still makes some requests of its own, for example to SmartScreen and to `edge.microsoft.com`. They go through 3proxy, as all of its traffic does.

### Isolation

- Edge runs as the `browser` user, which is not an administrator.
- Windows Firewall blocks new connections to `10.0.2.2`, so a browser cannot reach services on the host's loopback, such as the app or its database.
- The QEMU guest agent runs with all of its commands, which can run programs and read files in the guest. Only the host can reach it, over a Unix socket.

### Check a VM

`vm/scripts/run.js windows-11` starts a VM from the snapshot. The guest has no shell on the terminal. Watch the screen with a VNC viewer at `127.0.0.1:5900`, or the port in `VNC_PORT`. The VNC port of each browser's VM is in `machines/<id>/vnc-port` in the data directory.
