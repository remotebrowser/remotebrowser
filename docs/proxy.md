# Proxy

All of the browser's traffic goes through [tinyproxy](https://tinyproxy.github.io), an HTTP proxy that runs inside each VM, on `127.0.0.1:8119`. It refuses the domains in a denylist, and can forward to an upstream proxy. Its files are in `vm/files/etc/tinyproxy`, so they go into the VM image. See [Sandboxing](sandboxing.md) for how the image is built.

The browser finds the proxy through `--proxy-server` in `/etc/remotebrowser/browser.env`. The `chromium` service requires `tinyproxy`, so the browser does not start without it.

## Blocklist

tinyproxy refuses the domains in a denylist, so the browser cannot reach them. Two lists in `vm/files/etc/tinyproxy` control it:

- `denylist.txt` lists the domains to block. Each entry also blocks its subdomains.
- `allowlist.txt` lists domains to take out of the denylist. This matters most when the denylist is a large public blocklist that blocks too much.

Both take one domain per line, and `#` starts a comment. The image ships with a few example entries, such as `doubleclick.net`.

The browser gets `ERR_TUNNEL_CONNECTION_FAILED` for a blocked domain, and `journalctl -u tinyproxy` logs `Proxying refused on filtered domain`.

Every time tinyproxy starts or reloads, `/usr/local/sbin/tinyproxy-filter` turns the two lists into tinyproxy's filter, `/run/tinyproxy-filter`. So the lists can change without building the image again:

- To change them for all new browsers, edit the files in `vm/files/etc/tinyproxy`, then build again.
- To try a change in a running VM, edit `/etc/tinyproxy/denylist.txt` or `allowlist.txt` in its root shell, then run `systemctl reload tinyproxy`.

## Change the proxy

The browser always uses tinyproxy, so `vm/files/etc/tinyproxy/tinyproxy.conf` decides how the browser reaches the internet. By default, tinyproxy connects to sites directly. To send all browser traffic through another proxy, for example for a fixed egress IP address, uncomment one `Upstream` line in that file:

```
Upstream http user:password@proxy.example.com:8080
```

See the comments in that file, and `man tinyproxy.conf`, for the other options.

Then build the image again. VMs that are already running keep their old configuration; new browsers get the new one.

To try a change first, start a VM with `vm/scripts/run.js` (see [Manual test](sandboxing.md#manual-test)), then edit the file in the VM's root shell and reload tinyproxy:

```bash
nano /etc/tinyproxy/tinyproxy.conf
systemctl reload tinyproxy
journalctl -u tinyproxy -f             # watch the browser's requests go through
```

Connections that the browser already has open keep their old route until they close, so test with a site you have not opened yet. A change to `Port` or `Listen` needs `systemctl restart tinyproxy` and a restart of `chromium`, and then `--proxy-server` in `/etc/remotebrowser/browser.env` must match. The edit is lost when the VM stops, because `vm/scripts/run.js` starts from a throwaway copy of the snapshot's disk.
