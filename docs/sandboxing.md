# Sandboxing

Remote Browser runs each browser in its own [QEMU](https://www.qemu.org) virtual machine (VM). The app sets this up by itself. This page explains what happens behind the scenes, and how to test a VM by hand. See [Setup](setup.md) for what the host needs.

## Behind the scenes

Each browser runs on one of several guest OSes, such as Debian 13, the default, or Windows 11, chosen on the launch page. See [VM](vm.md) for each OS, and for what runs inside its VM. The launch page offers an OS once its snapshot is ready. The app keeps an image and a snapshot per OS, so a host can run browsers of each at once.

At startup, in the background, the app prepares two things for each OS, all OSes at once. The server does not wait for them, and it logs each step with `event.domain` set to `qemu`.

1. **Image**: the app builds the disk image of each OS from its sources in `vm`. This happens when the image is missing, or when one of its sources changed. The image goes to `images/<os>` in the [data directory](#data-directory), such as `images/debian-13`. It is built for the host's architecture only, `x86_64` or `aarch64`, so that KVM on Linux, or Hypervisor.framework (HVF) on macOS, runs it natively.
2. **Snapshot**: the app boots the image once, until the guest is ready but before the browser starts, and saves the running VM as a snapshot in `snapshots/<os>` in the data directory. It saves a new one when the image, `VM_MEMORY`, or `VM_CPUS` change.

Then every new browser is a VM started from the snapshot of its OS. Before the browser starts, the app writes its settings into the guest, such as the proxy and the screen size. Then it sets the guest clock, which stopped when the snapshot was saved, and the browser starts. The browser starts only after the snapshot, so that VMs do not share its random number state. The app waits until the browser answers on CDP.

Each VM gets `VM_MEMORY` of memory (default `4G`) and `VM_CPUS` virtual CPUs (default `2`). Memory is the main limit on how many browsers one host can run.

Starting a VM is heavy on the CPU. When many start at once, they slow each other down until none of them start in time. So the host starts at most one VM for every `2 × VM_CPUS` cores at once (4 on 16 cores with the default `VM_CPUS`), and VMs that resume count too. A launch over that limit is refused with HTTP 429 and a `Retry-After` header. A resume is never refused, because its browser already exists.

Until a snapshot exists, browsers cannot be launched on its OS, and the app logs why.

## Isolation

The VM is isolated in these ways, on every OS:

- QEMU has only the devices it needs (`-nodefaults`). On Linux, it also runs under its seccomp sandbox (`-sandbox on`). QEMU on macOS has no seccomp, so there the VM boundary is the main protection.
- QEMU user-mode networking gives the VM its own network. A firewall in the VM blocks `10.0.2.2`, which leads to the host's loopback, so a browser cannot reach services there, such as the app or its database. IPv6 is off for the same reason. The VM can still reach other hosts on the network; to limit that, use a host firewall or an [upstream proxy](proxy.md).
- All of the browser's traffic goes through a local [proxy](proxy.md) in the VM.
- Only the CDP port is forwarded, and only to `127.0.0.1` on the host. QEMU's own VNC server shows the screen, also only on `127.0.0.1`. It has no password, so do not expose it beyond the host's loopback.
- The app talks to the QEMU guest agent over a Unix socket, which only the app's user can open. It uses the agent to set the clock and to write the browser's settings.

See [VM](vm.md) for what each OS adds, such as the user that the browser runs as.

## Lifecycle

A new browser gets a directory `machines/<id>` in the data directory, which only the app's user can read. It holds the VM's overlay disk, which records only its changes to the image, plus the QEMU sockets, the forwarded ports, and two logs: `qemu.log` from QEMU and `console.log` from the guest.

- **Running**: QEMU runs detached from the app, so browsers keep running across an app restart.
- **Suspend**: QEMU saves the VM's memory to `suspended.state` and exits, which frees the memory. The app compresses the file with `zstd`, if the host has it. Just before, the app takes a screenshot of each open page and keeps them in `suspended-previews`, so the browser's page can show them while it is suspended.
- **Resume**: the app starts QEMU again from the saved state, so the browser carries on with the same pages, and sets the guest clock again. It deletes the screenshots, as the pages are live again.
- **Terminate**: the app stops QEMU and deletes the directory, so nothing of the session is left behind.

## Data directory

The app keeps everything for the VMs in one directory, `.data/vm` by default. Set `VM_DATA_DIR` to use another one. Keep it on a persistent disk, so browsers, suspended ones included, survive a restart of the host.

```
.data/vm/
├── images/
│   ├── debian-13/
│   │   └── x86_64-<source>/
│   │       ├── chromium.qcow2
│   │       ├── chromium.kernel
│   │       └── chromium.initrd
│   ├── ubuntu-26.04/
│   ├── fedora-44/
│   └── windows-11/
├── snapshots/
│   ├── debian-13/
│   ├── ubuntu-26.04/
│   ├── fedora-44/
│   └── windows-11/
├── iso/
├── machines/
│   └── <id>/
└── run/
```

- **`images`** holds the builds of each OS's image. A build is named after its architecture and a hash of its sources, such as `vm/debian-13/Dockerfile` and `vm/linux/files` for Debian 13. When those change, the next build goes to a new directory. A build never changes after it is written, because a VM's disk records only its changes to that exact image. The app deletes a build when it is out of date, and neither a snapshot nor any VM uses it.
- **`snapshots`** holds the snapshot of each OS that new browsers start from: its disk (`overlay.qcow2`), its memory (`vm.state`), and `machine.json`, which names the OS and the image build it runs on. While the app saves a new snapshot, it works in `snapshots/<os>.new.<pid>` and replaces `snapshots/<os>` only when it is done.
- **`iso`** holds what the Windows image is installed from; see [VM](vm.md#windows).
- **`machines`** holds one directory per browser, as described in [Lifecycle](#lifecycle).
- **`run`** holds the VM that `vm/scripts/run.js` starts, as described in [Manual test](#manual-test).

QEMU talks to the app over Unix sockets in these directories, and Linux limits a socket path to 107 characters (macOS to 103). If `VM_DATA_DIR` is too long for that, the app refuses to start.

In the container, the app can build a Linux image only with the host's Docker socket, since it has no Docker of its own. [Getting Started](getting-started.md) gives the server the socket, for a quick try. The socket gives full control of the host, and the server runs untrusted pages, so do not do this for a server that others use. Instead, build the image in a separate container, as [VM image](self-hosting.md#vm-image) shows. The image build does not use bind mounts, so it works from a container.

To share the data directory between the container and the scripts in `vm/scripts` on the host, mount it at the same path in the container, and set `VM_DATA_DIR` to that path. The snapshot and the VMs refer to their image build by its full path, so the path must be the same on both sides.

## Manual test

The scripts in `vm` do the same steps as the app, and read the same settings. To build the image and save a snapshot of each OS, all at once:

```bash
npm install
vm/build-image.sh
```

It runs `vm/build-debian-13.sh`, `vm/build-ubuntu-26.04.sh`, and `vm/build-fedora-44.sh`, each of which builds one OS, and `vm/build-windows-11.sh` when the Windows ISO is there.

To start a VM from the snapshot of an OS:

```bash
vm/scripts/run.js               # Debian 13
vm/scripts/run.js windows-11    # or any other OS
```

The VM's console is your terminal; on Linux, it has a root shell, and you may need to press Enter for a prompt. In another terminal, check that the browser answers, and open a page:

```bash
curl http://127.0.0.1:9222/json/version
curl -X PUT "http://127.0.0.1:9222/json/new?https://example.com"
```

See [VM](vm.md) for what else to check in each OS.

To quit, press Ctrl-A then X.

`vm/scripts/run.js` writes to a throwaway copy of the snapshot's disk in `run` in the data directory (or in `RUN_DIR`), so the snapshot stays as it is. Set `CDP_PORT` and `VNC_PORT` to use other ports (defaults `9222` and `5900`). To run several VMs at once, give each its own `RUN_DIR` and ports.

From another terminal:

- `vm/scripts/suspend.js` suspends the running VM, and `vm/scripts/resume.js` resumes it, as the app does.
- `vm/scripts/qmp.js .data/vm/run/qmp.sock query-status` sends a QMP command to QEMU. With `--agent` and `.data/vm/run/qga.sock`, it talks to the guest agent instead.
