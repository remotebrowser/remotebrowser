# Display

The browser runs on [labwc](https://labwc.github.io), a Wayland compositor, inside each VM, on the VM's virtual GPU (`virtio-gpu-pci`). QEMU itself shows that screen over VNC, on the host's loopback, so the guest runs no VNC server. By default, the screen is 1920×1080, at a scale of 150%. labwc keeps every browser window maximized on it, without a title bar, so each page gets the whole screen. It draws in software, since the VM has no 3D GPU.

The launch page offers these screen resolutions:

| Resolution        | Screen    |
| ----------------- | --------- |
| Full HD (default) | 1920×1080 |
| WUXGA             | 1920×1200 |
| QHD               | 2560×1440 |
| 4K                | 3840×2160 |

The app can give each browser its own screen size, when it launches the browser or at any time while the browser runs:

```js
await startBrowser({ screenResolution: { width: 2560, height: 1440 } });
await setBrowserScreenResolution(browserId, { width: 1366, height: 768 });
await setBrowserScreenResolution(browserId, null); // the default again
```

The width and height are in pixels, from 640×480 to 3840×2160. See `src/vm/screen-resolution.js`.

A new size takes effect at once. The browser keeps running, with its pages and CDP connections, and its window stays maximized on the new screen. `setBrowserScreenResolution` returns once the screen has the new size, so the next screenshot already has it.

How it works:

1. The app writes the size, such as `1366x768`, or `default`, as one line into `/etc/remotebrowser/screen-resolution` in the guest, through the guest agent.
2. `screen-resolution.path` sees the change, and `/usr/local/bin/screen-resolution` sets the labwc output to it with `wlr-randr`. Only numbers go into the commands. The app waits until the VNC handshake reports the new size. The virtual GPU pads each row of the screen to 16 pixels, so for a width such as 1366, VNC shows a black strip, up to 15 pixels wide, on the right. The browser sees the size that was asked for.
3. labwc resizes the maximized windows to fit. A window rule in `/etc/remotebrowser/labwc/rc.xml` maximizes each new window, also one that a new browser context opens.

At launch, the app sets the size before it sets the clock, which starts the browser (see `chromium-start.timer`), so the browser starts on that screen. The setting is on the VM's disk, so it stays across a suspend and resume. If the file does not hold exactly one valid line, for example after a write that did not finish, the screen keeps its size. labwc starts at 1920×1080, the size QEMU offers, for example after a crash, and sets the screen size again right after.

Check it in the VM's root shell with `XDG_RUNTIME_DIR=/run/display WAYLAND_DISPLAY=wayland-0 wlr-randr`, or `journalctl -u screen-resolution -u display`.

## Screen scale

The browser can also scale its pages and its own controls, like a desktop set to 125%. By default, the scale is 150%. The launch page has a slider from 100% to 200%, in steps of 25%.

```js
await startBrowser({ screenScale: 200 });
await setBrowserScreenScale(browserId, 100);
await setBrowserScreenScale(browserId, null); // 150% again
```

The scale is in percent, from 100% to 300%, in steps of 25%. See `src/vm/screen-scale.js`.

The screen keeps its size in pixels, so at 150%, a 1920×1080 screen shows pages as if it were 1280×720, with sharper text. The browser keeps running, with its pages and CDP connections, and follows the new scale without a restart. In a page, `devicePixelRatio` is the scale, e.g. `1.5`. Nothing outside the guest shows the change, so `setBrowserScreenScale` returns once the guest has the new value, and the browser follows a moment later.

How it works:

1. The app writes the scale, such as `150`, or `default`, as one line into `/etc/remotebrowser/screen-scale` in the guest, through the guest agent.
2. `screen-scale.path` sees the change, and `/usr/local/bin/screen-scale` sets the labwc output scale to it with `wlr-randr`.
3. Chromium runs natively on Wayland, and follows the new scale at once, through the fractional scale protocol. labwc forgets the scale when it restarts, so `display.service` sets it again.

As for the screen size, the app sets the scale before the clock at launch, the setting stays across a suspend and resume, and a file without exactly one valid line leaves the scale as it is.

Check it with `wlr-randr`, as above, or `journalctl -u screen-scale`.
