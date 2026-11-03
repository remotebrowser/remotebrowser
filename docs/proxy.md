# Proxy

All of the browser's traffic goes through a local proxy that runs inside each VM, on `127.0.0.1:8119`. The browser finds it through its `--proxy-server` flag. Linux runs [tinyproxy](https://tinyproxy.github.io), and Windows runs [3proxy](https://3proxy.org). See [VM](vm.md) for what else runs in the VM.

## Upstream proxy

By default, the local proxy connects to sites directly. The app can give each browser its own upstream proxy, for example for a fixed egress IP address, when it launches the browser or at any time while the browser runs:

```js
await startBrowser({ proxy: 'http://user:password@proxy.example.com:8080' });
await setBrowserProxy(browserId, 'socks5://proxy.example.com:1080');
await clearBrowserProxy(browserId); // direct again
```

The URL starts with `http://`, `socks4://`, or `socks5://`. An HTTP proxy carries HTTPS too, with `CONNECT`. The proxy may be on a private network, such as `10.0.0.5` or `192.168.1.20`, which is common for an egress proxy. A loopback, link-local, multicast, or reserved address (such as `127.0.0.1` or `169.254.169.254`) is refused, as is `localhost`, since no proxy can be there. The user and password can only have letters, digits, and `- . _ ~ ! $ & * + , ; =`, since the guest puts them into the proxy's config as they are.

The app writes the URL, or `direct`, as one line into a file in the guest, through the guest agent. The guest then restarts its local proxy with it. The restart also ends the browser's open connections, so none of them keep the old route. Requests that are in flight at that moment fail.

At launch, the app sets the proxy before the browser starts, so even its first request takes that route. The setting is on the VM's disk, so it stays across a suspend and resume. If the file does not hold exactly one valid line, for example after a write that did not finish, the browser stays offline rather than going out directly.

## Linux

tinyproxy refuses the domains in a denylist, and forwards the rest to the upstream proxy, if there is one. Its files are in `vm/linux/files/etc/tinyproxy`, so they go into the VM image. The `chromium` service requires `tinyproxy`, so the browser does not start without it.

### Denylist

Two lists in `vm/linux/files/etc/tinyproxy` decide which domains tinyproxy refuses, so the browser cannot reach them:

- `denylist.txt` lists the domains to block. Each entry also blocks its subdomains.
- `allowlist.txt` lists domains to take out of the denylist. This matters most when the denylist is a large public blocklist that blocks too much.

Both take one domain per line, and `#` starts a comment. The image ships with a few example entries, such as `doubleclick.net`.

The browser gets `ERR_TUNNEL_CONNECTION_FAILED` for a blocked domain, and `journalctl -u tinyproxy` logs `Proxying refused on filtered domain`.

Every time tinyproxy starts or reloads, `/usr/local/bin/tinyproxy-filter` turns the two lists into tinyproxy's filter, `/run/tinyproxy-filter`. So the lists can change without building the image again:

- To change them for all new browsers, edit the files in `vm/linux/files/etc/tinyproxy`, then build again.
- To try a change in a running VM, edit `/etc/tinyproxy/denylist.txt` or `allowlist.txt` in its root shell, then run `systemctl reload tinyproxy`.

### How the upstream proxy is set

1. The app writes the URL into `/etc/remotebrowser/proxy/upstream`. Only root can read that directory, so the browser cannot read the password.
2. `tinyproxy-upstream.path` sees the change and restarts tinyproxy.
3. Before tinyproxy starts, `/usr/local/bin/tinyproxy-config` builds its config, `/run/tinyproxy.conf`, from `/etc/tinyproxy/tinyproxy.conf` plus an `Upstream` line for that URL. With a file that is not valid, tinyproxy does not start.

Check it in the VM's root shell with `journalctl -u tinyproxy`, which logs `Added upstream` when it starts.

## Windows

3proxy runs as a Windows service, from `C:\Program Files\3proxy`. The app downloads `3proxy-1.0.2-x64.zip` to `iso/` in the data directory the first time, and `remotebrowser-setup.ps1` installs `3proxy.exe` from it while the image is built. 3proxy has no denylist.

### How the upstream proxy is set

1. The app writes the URL into `C:\ProgramData\remotebrowser\proxy`.
2. `proxy.ps1` runs as SYSTEM at each logon, and watches that file. It turns the line into `C:\Program Files\3proxy\3proxy.cfg`, with a `parent` line for the upstream proxy and its user and password, and restarts the 3proxy service when the config changes. With a file that is not valid, the `parent` line points at a port where nothing listens.
3. Once 3proxy runs with the proxy that the file names, `proxy.ps1` writes the same text into `C:\ProgramData\remotebrowser\proxy-applied`. At launch, `browser.ps1` starts Edge only once that file matches.

Check it in the guest with `Get-Service 3proxy`, and in `C:\Program Files\3proxy\3proxy.cfg`.
