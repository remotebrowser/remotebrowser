# Dokku Deployment

Install [Podman](https://podman.io) and verify it:

```
sudo apt install -y podman
sudo podman run hello-world
```

Enable the Podman systemd socket and verify it:

```
sudo systemctl enable --now podman.socket
systemctl status podman.socket --no-pager
```

Override the socket path by running `sudo systemctl edit podman.socket` and editing the contents to:

```
[Socket]
ListenStream=
ListenStream=/run/podman.sock
SocketMode=0666
```

Reboot the machine.

Quick test (should display full Podman information and not throw any errors):

```
CONTAINER_HOST="unix:///run/podman.sock" podman --remote info
```

Run the test again to verify that the Podman socket permissions persist after reboot:

Another test:

```
CONTAINER_HOST="unix:///run/podman.sock" podman --remote run hello-world
```

Install and configure [Tailscale](https://tailscale.com) on the host machine:

```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Verify that the machine appears on the [Tailscale admin console page](https://login.tailscale.com/admin/machines).

Install Dokku per [the official guide](https://dokku.com/docs/getting-started/installation):

```
wget -NP . https://dokku.com/install/v0.37.2/bootstrap.sh
sudo DOKKU_TAG=v0.37.2 bash bootstrap.sh
```

Add at least one SSH key for manual deployment.

Create the app:

```
dokku apps:create remotebrowser
dokku ports:add remotebrowser http:80:23456
dokku config:set remotebrowser CONTAINER_HOST="unix:///run/podman.sock"
dokku docker-options:add remotebrowser deploy "--cap-add=NET_ADMIN"
dokku docker-options:add remotebrowser deploy "--cap-add=NET_RAW"
dokku docker-options:add remotebrowser deploy "--device=/dev/net/tun:/dev/net/tun"
dokku docker-options:add remotebrowser deploy,run "-v /run/podman.sock:/run/podman.sock"
```

Set the domain (optional):

```
dokku domains:set remotebrowser remotebrowser.example.com
```

Then deploy Remote Browser manually to this Dokku machine.

## Resource limits

Rootful Podman places all container cgroups under `machine.slice`. Setting limits on this slice caps the combined CPU and memory of every browser container on the host.

### Step 1 — Inspect host resources

```bash
nproc
free -h
mount | grep cgroup2   # confirm cgroup v2 is active
```

### Step 2 — Confirm which slice owns the containers

```bash
systemd-cgls | grep -E 'libpod|\.slice'
```

Expected (rootful Podman on Debian/Ubuntu):

```
machine.slice
  |-libpod-<id>.scope
  `-libpod-conmon-<id>.scope
```

If containers appear under a different slice, target that slice instead.

### Step 3 — Check existing limits (baseline)

```bash
systemctl show machine.slice --property=MemoryHigh,MemoryMax,MemorySwapMax,CPUQuotaPerSecUSec
```

All values will be `infinity` / `max` on a fresh host.

### Step 4 — Determine limit values

Use these formulas based on host specs:

| Setting      | Formula                    | Example (32 cores / 64GB) |
| ------------ | -------------------------- | ------------------------- |
| `MemoryHigh` | `total_RAM × 0.78`         | `50G`                     |
| `MemoryMax`  | `total_RAM × 0.875`        | `56G`                     |
| `CPUQuota`   | `(total_cores − 2) × 100%` | `3000%`                   |

Scaling reference by concurrent container count:

| Containers | MemoryHigh | MemoryMax | CPUQuota |
| ---------- | ---------- | --------- | -------- |
| ~20        | 22G        | 26G       | 1600%    |
| ~40        | 42G        | 48G       | 2800%    |
| ~60        | 50G        | 56G       | 3000%    |

### Step 5 — Apply the drop-in

```bash
sudo systemctl edit machine.slice
```

Paste (adjust values for your host):

```ini
[Slice]
MemoryHigh=50G
MemoryMax=56G
MemorySwapMax=0
CPUQuota=3000%
```

Reload (no restart needed):

```bash
sudo systemctl daemon-reload
```

### Step 6 — Verify limits are active

```bash
# Via systemd
systemctl show machine.slice --property=MemoryHigh,MemoryMax,MemorySwapMax,CPUQuotaPerSecUSec

# Directly from the kernel (ground truth)
cat /sys/fs/cgroup/machine.slice/memory.high   # expect 53687091200 (50GiB)
cat /sys/fs/cgroup/machine.slice/memory.max    # expect 60129542144 (56GiB)
cat /sys/fs/cgroup/machine.slice/cpu.max       # expect 30000000 100000 (3000%)
```

### Step 7 — Verify limits survive reboot

```bash
sudo reboot
# after reboot:
systemctl show machine.slice --property=MemoryHigh,MemoryMax,CPUQuotaPerSecUSec
```

**What each setting does:**

- `MemoryHigh` — soft ceiling; kernel throttles and reclaims pages before killing anything
- `MemoryMax` — hard ceiling; OOM-kills heaviest processes if memory climbs past this despite throttling
- `MemorySwapMax=0` — disables swap for all containers (Chromium degrades badly on swap)
- `CPUQuota` — caps total CPU time across all containers; leaves 2 cores for OS + app

Once deployed, test it by launching a machine:

```
curl remotebrowser-ip-address/api/v1/start/xyz123
```
