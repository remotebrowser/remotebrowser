# Sandboxing

Remote Browser runs each browser in its own [QEMU](https://www.qemu.org) virtual machine (VM). The app sets this up by itself. This page explains what happens behind the scenes, and how to test a VM by hand. See [Setup](setup.md) for what the host needs.

## Behind the scenes

At startup, in the background, the app prepares two things. The server does not wait for them, and it logs each step with `event.domain` set to `qemu`.

1. **Image**: the app builds the VM image from `vm/Dockerfile` with Docker. This happens when the image is missing, or when `vm/Dockerfile` or `vm/files` changed. Docker only installs the packages; the result never runs as a container. The image goes to `images` in the [data directory](#data-directory), as a qcow2 disk with its kernel and initrd. It is built for the host's architecture only, `x86_64` or `aarch64`, so that KVM on Linux, or Hypervisor.framework (HVF) on macOS, runs it natively.
2. **Snapshot**: the app boots the image once, until the guest is ready but before the browser starts, and saves the running VM as a snapshot in `snapshot` in the data directory. It saves a new one when the image, `VM_MEMORY`, or `VM_CPUS` change.

Then every new browser is a VM started from that snapshot. The app sets the guest clock, which starts the browser. The browser starts only after the snapshot, so that VMs do not share its random number state.

Each VM gets `VM_MEMORY` of memory (default `2G`) and `VM_CPUS` virtual CPUs (default `2`). Memory is the main limit on how many browsers one host can run.

Until the snapshot exists, launching a browser fails, and the app logs why. With `BROWSERFLEET_URL` set, the app runs no VMs, and skips all of this.

## Inside each VM

The VM is a small Debian 13 system with systemd. Its services, all in `vm/files`, are:

| Service            | What it does                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `systemd-networkd` | Gets the guest address from QEMU user-mode networking by DHCP (`10.0.2.15`, gateway `10.0.2.2`, DNS `10.0.2.3`) |
| `nftables`         | Refuses new connections to `10.0.2.2`, which leads to the host's loopback interface                             |
| `tinyproxy`        | The HTTP proxy that all of the browser's traffic goes through, on `127.0.0.1:8119`. See [Proxy](proxy.md)       |
| `xvnc`             | A virtual 1920×1080 display, 24-bit, shared over VNC on port `5900`                                             |
| `chromium`         | Debian's Chromium on that display, as the unprivileged `browser` user, with CDP on `127.0.0.1:9221`             |
| `chromium-start`   | A timer that starts `chromium` when the host sets the clock, after a VM starts from the snapshot                |
| `guest-ready`      | Writes `remotebrowser: guest ready` to the console once the others are up, so the host can save the snapshot    |
| `cdp-proxy`        | Exposes CDP on port `9222` of the guest address, which is where QEMU forwards the host port                     |

The browser has a display rather than running headless. The VM has no GPU, so WebGL renders in software, and complex 3D pages run slowly. Chromium reads its flags from `/etc/remotebrowser/browser.env`. It does not start without `nftables` and `tinyproxy`.

To change what runs in the VM, edit `vm/Dockerfile` or `vm/files`. The app builds the image again at its next start.

The VM is isolated in these ways:

- The browser runs as an unprivileged user, so its own sandbox stays on.
- QEMU has only the devices it needs (`-nodefaults`). On Linux, it also runs under its seccomp sandbox (`-sandbox on`). QEMU on macOS has no seccomp, so there the VM boundary is the main protection.
- The QEMU guest agent accepts only the commands that set the clock.
- Only the CDP and VNC ports are forwarded, and only to `127.0.0.1` on the host. The VNC port has no password, so do not expose it beyond the host's loopback.
- A firewall in the VM blocks `10.0.2.2`, so a browser cannot reach services on the host's loopback, such as the app or its database. IPv6 is off for the same reason. The VM can still reach other hosts on the network; to limit that, use a host firewall or an [upstream proxy](proxy.md#change-the-proxy).

## Lifecycle

A new browser gets a directory `machines/<id>` in the data directory, which only the app's user can read. It holds the VM's overlay disk, which records only its changes to the image, plus the QEMU sockets, the forwarded ports, and two logs: `qemu.log` from QEMU and `console.log` from the guest.

- **Running**: QEMU runs detached from the app, so browsers keep running across an app restart.
- **Suspend**: QEMU saves the VM's memory to `suspended.state` and exits, which frees the memory. The app compresses the file with `zstd`, if the host has it.
- **Resume**: the app starts QEMU again from the saved state, so the browser carries on with the same pages, and sets the guest clock again.
- **Terminate**: the app stops QEMU and deletes the directory, so nothing of the session is left behind.

Suspend and resume work only with local VMs, not with an external fleet (`BROWSERFLEET_URL`).

## Data directory

The app keeps everything for the VMs in one directory, `.data/vm` by default. Set `VM_DATA_DIR` to use another one. Keep it on a persistent disk, so browsers, suspended ones included, survive a restart of the host.

```
.data/vm/
├── images/
│   └── x86_64-<source>/
│       ├── chromium.qcow2
│       ├── chromium.kernel
│       └── chromium.initrd
├── snapshot/
├── machines/
│   └── <id>/
└── run/
```

- **`images`** holds the builds of the VM image. A build is named after its architecture and a hash of `vm/Dockerfile` and `vm/files`. When those files change, the next build goes to a new directory. A build never changes after it is written, because a VM's disk records only its changes to that exact image. The app deletes a build when it is out of date, and neither the snapshot nor any VM uses it.
- **`snapshot`** holds the snapshot that new browsers start from: its disk (`overlay.qcow2`), its memory (`vm.state`), and `machine.json`, which names the image build it runs on. While the app saves a new snapshot, it works in `snapshot.new.<pid>` and replaces `snapshot` only when it is done.
- **`machines`** holds one directory per browser, as described in [Lifecycle](#lifecycle).
- **`run`** holds the VM that `vm/scripts/run.js` starts, as described in [Manual test](#manual-test).

QEMU talks to the app over Unix sockets in these directories, and Linux limits a socket path to 107 characters (macOS to 103). If `VM_DATA_DIR` is too long for that, the app refuses to start.

In the container, the app can build the VM image only with the host's Docker socket, since it has no Docker of its own. [Getting Started](getting-started.md) gives the server the socket, for a quick try. The socket gives full control of the host, and the server runs untrusted pages, so do not do this for a server that others use. Instead, build the image in a separate container, as [VM image](self-hosting.md#vm-image) shows. The image build does not use bind mounts, so it works from a container.

To share the data directory between the container and the scripts in `vm/scripts` on the host, mount it at the same path in the container, and set `VM_DATA_DIR` to that path. The snapshot and the VMs refer to their image build by its full path, so the path must be the same on both sides.

## Manual test

The scripts in `vm/scripts` do the same steps as the app, and read the same settings. To build the image and save a snapshot:

```bash
npm install
vm/scripts/build.js
```

To start a VM from the snapshot:

```bash
vm/scripts/run.js
```

The VM's console is your terminal, with a root shell; press Enter if no prompt shows. In another terminal, check that the browser answers, and open a page:

```bash
curl http://127.0.0.1:9222/json/version
curl -X PUT "http://127.0.0.1:9222/json/new?https://example.com"
```

In the VM's root shell, you can look at the services:

```bash
systemctl status chromium cdp-proxy tinyproxy nftables
journalctl -u chromium
```

To quit, press Ctrl-A then X.

`vm/scripts/run.js` writes to a throwaway copy of the snapshot's disk in `run` in the data directory (or in `RUN_DIR`), so the snapshot stays as it is. Set `CDP_PORT` and `VNC_PORT` to use other ports (defaults `9222` and `5900`). To run several VMs at once, give each its own `RUN_DIR` and ports.

From another terminal:

- `vm/scripts/suspend.js` suspends the running VM, and `vm/scripts/resume.js` resumes it, as the app does.
- `vm/scripts/qmp.js .data/vm/run/qmp.sock query-status` sends a QMP command to QEMU. With `--agent` and `.data/vm/run/qga.sock`, it talks to the guest agent instead.
