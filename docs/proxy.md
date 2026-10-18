# Proxy

All of the browser's traffic goes through [tinyproxy](https://tinyproxy.github.io), an HTTP proxy that runs inside each VM, on `127.0.0.1:8119`. It refuses the domains in a denylist, and can forward to an upstream proxy. Its files are in `vm/files/etc/tinyproxy`, so they go into the VM image. See [Sandboxing](sandboxing.md) for how the image is built.

The browser finds the proxy through `--proxy-server` in `/etc/remotebrowser/browser.env`. The `chromium` service requires `tinyproxy`, so the browser does not start without it.

Two lists in `vm/files/etc/tinyproxy` decide which domains tinyproxy refuses, so the browser cannot reach them:

- `denylist.txt` lists the domains to block. Each entry also blocks its subdomains.
- `allowlist.txt` lists domains to take out of the denylist. This matters most when the denylist is a large public blocklist that blocks too much.

Both take one domain per line, and `#` starts a comment. The image ships with a few example entries, such as `doubleclick.net`.

The browser gets `ERR_TUNNEL_CONNECTION_FAILED` for a blocked domain, and `journalctl -u tinyproxy` logs `Proxying refused on filtered domain`.

Every time tinyproxy starts or reloads, `/usr/local/sbin/tinyproxy-filter` turns the two lists into tinyproxy's filter, `/run/tinyproxy-filter`. So the lists can change without building the image again:

- To change them for all new browsers, edit the files in `vm/files/etc/tinyproxy`, then build again.
- To try a change in a running VM, edit `/etc/tinyproxy/denylist.txt` or `allowlist.txt` in its root shell, then run `systemctl reload tinyproxy`.

By default, tinyproxy connects to sites directly. The app can give each browser its own upstream proxy, for example for a fixed egress IP address, when it launches the browser or at any time while the browser runs:

```js
await startBrowser({ proxy: 'http://user:password@proxy.example.com:8080' });
await setBrowserProxy(browserId, 'socks5://proxy.example.com:1080');
await clearBrowserProxy(browserId); // direct again
```

The URL starts with `http://`, `socks4://`, or `socks5://`. An HTTP proxy carries HTTPS too, with `CONNECT`. tinyproxy does not decode the user and password, so they can only have letters, digits, and `- . _ ~ ! $ & * + , ; =`. See `src/vm/proxy.js`. Only local VMs have this; with `BROWSERFLEET_URL`, the calls answer `NOT_SUPPORTED`.

How it works:

1. The app writes the URL, or `direct`, as one line into `/etc/remotebrowser/proxy/upstream` in the guest, through the guest agent. Only root can read that directory, so the browser cannot read the password.
2. `tinyproxy-upstream.path` sees the change and restarts tinyproxy. The restart also ends the browser's open connections, so none of them keep the old route. Requests that are in flight at that moment fail.
3. Before tinyproxy starts, `/usr/local/sbin/tinyproxy-config` builds its config, `/run/tinyproxy.conf`, from `/etc/tinyproxy/tinyproxy.conf` plus an `Upstream` line for that URL.

At launch, the app sets the proxy before the browser starts, so even its first request takes that route. The setting is on the VM's disk, so it stays across a suspend and resume. If the file does not hold exactly one valid line, for example after a write that did not finish, tinyproxy does not start, and the browser stays offline rather than going out directly.

Check it in the VM's root shell with `journalctl -u tinyproxy`, which logs `Added upstream` when it starts.
