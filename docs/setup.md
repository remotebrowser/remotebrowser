# Setup

This page shows how to run the latest development version of Remote Browser from source, on Linux or on macOS.

## Linux

You need:

- A Linux host, either x86_64 (Intel or AMD) or aarch64 (Arm).
- The latest [Node.js LTS](https://nodejs.org).
- [QEMU](https://www.qemu.org): `qemu-system-x86_64` (or `qemu-system-aarch64` on Arm) and `qemu-img`.
- [KVM](https://linux-kvm.org), and a user in the `kvm` group.
- [Docker](https://www.docker.com), to build the VM image.
- About 10 GB of free disk space, for building the VM image.
- [Zstandard](https://facebook.github.io/zstd/), to compress the suspended virtual machines.

On Debian or Ubuntu, install them with:

```bash
sudo apt-get install qemu-system-x86 qemu-utils zstd    # on Arm: qemu-system-arm
sudo usermod -aG kvm "$USER"                            # then log out and log back in
```

Get the source:

```bash
git clone https://github.com/remotebrowser/remotebrowser.git
cd remotebrowser
```

Check that your host can run the browser VMs:

```bash
vm/doctor.sh
```

It checks QEMU, KVM, and Zstandard. If QEMU or KVM is missing, it stops with an error. A missing Zstandard only gives a warning. Fix any problems before you continue.

Start Remote Browser:

```bash
npm install
npm start
```

At startup, the server builds the VM image and saves its snapshot by itself, if they are missing or out of date. The first run takes a while for this, but both are kept on disk in `.data/vm`, so later runs start quickly. See [Data directory](sandboxing.md#data-directory).

Then open `localhost:3000`.

Sign in with any email address. Because this setup has no SMTP server, it cannot email you a sign-in link. The server prints the link to its console. Open that link to continue.

If you start the server without `DATABASE_URL`, this setup falls back to [PGlite](https://pglite.dev/), an embedded Postgres. It keeps the database in `.data/pglite`.

## macOS

You need:

- A Mac with Apple silicon.
- The latest [Node.js LTS](https://nodejs.org).
- [QEMU](https://www.qemu.org): `qemu-system-aarch64` and `qemu-img`.
- Hypervisor.framework (HVF), which macOS has built in. QEMU uses it to run the VMs natively.
- [Docker](https://www.docker.com), to build the VM image. [Docker Desktop](https://www.docker.com/products/docker-desktop/) works, and so does another Docker engine.
- About 10 GB of free disk space, for building the VM image.
- [Zstandard](https://facebook.github.io/zstd/), to compress the suspended virtual machines.

Install them with your package manager. The QEMU binary must be signed with the `com.apple.security.hypervisor` entitlement, because macOS lets only such a binary use Hypervisor.framework. Without it, the VMs run only under slow emulation.

Get the source:

```bash
git clone https://github.com/remotebrowser/remotebrowser.git
cd remotebrowser
```

Check that your host can run the browser VMs:

```bash
vm/doctor.sh
```

It checks QEMU, Hypervisor.framework, the signature of QEMU, and Zstandard. If QEMU or Hypervisor.framework is missing, or QEMU is not signed for it, it stops with an error. A missing Zstandard only gives a warning. Fix any problems before you continue.

Start Remote Browser:

```bash
npm install
npm start
```

At startup, the server builds the VM image and saves its snapshot by itself, if they are missing or out of date. The first run takes a while for this, but both are kept on disk in `.data/vm`, so later runs start quickly. See [Data directory](sandboxing.md#data-directory).

Then open `localhost:3000`.

Sign in with any email address. Because this setup has no SMTP server, it cannot email you a sign-in link. The server prints the link to its console. Open that link to continue.

If you start the server without `DATABASE_URL`, this setup falls back to [PGlite](https://pglite.dev/), an embedded Postgres. It keeps the database in `.data/pglite`.
