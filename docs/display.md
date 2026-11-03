# Display

The browser runs with a display rather than headless, on the VM's virtual GPU. QEMU itself shows that screen over VNC, on the host's loopback, so the guest runs no VNC server. By default, the screen is 1920×1080, at a scale of 150%. The browser window fills the whole screen. The VM has no 3D GPU, so the guest draws in software.

## Screen resolution

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

The app writes the size, such as `1366x768`, or `default`, as one line into a file in the guest, through the guest agent, and waits until the VNC handshake reports the new size. The guest sets its screen to it. If the file does not hold exactly one valid line, for example after a write that did not finish, the screen keeps its size. At launch, the app sets the size before the browser starts, so the browser starts on that screen. The setting is on the VM's disk, so it stays across a suspend and resume.

The virtual GPU pads each row of the screen, so for a width such as 1366, VNC shows a black strip on the right. The browser sees the size that was asked for.

### Linux

1. The app writes the size into `/etc/remotebrowser/screen-resolution`.
2. `screen-resolution.path` sees the change, and `/usr/local/bin/screen-resolution` sets the output of [labwc](https://labwc.github.io), the Wayland compositor, to it with `wlr-randr`. Only numbers go into the commands.
3. labwc resizes the maximized windows to fit. A window rule in `/etc/remotebrowser/labwc/rc.xml` maximizes each new window, also one that a new browser context opens, and gives it no title bar.

The GPU (`virtio-gpu-pci`) pads each row to 16 pixels, so the black strip is up to 15 pixels wide. labwc starts at 1920×1080, the size QEMU offers, for example after a crash, and sets the screen size again right after.

Check it in the VM's root shell with `XDG_RUNTIME_DIR=/run/display WAYLAND_DISPLAY=wayland-0 wlr-randr`, or `journalctl -u screen-resolution -u display`.

### Windows

1. The app writes the size into `C:\ProgramData\remotebrowser\screen-resolution`.
2. `screen-resolution.ps1` runs in the session of the `browser` account, since only that session can change its screen. It watches the file, and sets the size with `viogpures.exe`, from the virtio-win ISO. Unlike Windows itself, it takes any size.
3. Edge runs maximized, so its window follows the new screen.

The GPU driver pads each row to 32 pixels, so the black strip is up to 31 pixels wide. With no file, the screen is 1920×1080.

## Screen scale

The browser can also scale its pages and its own controls, like a desktop set to 125%. By default, the scale is 150%. The launch page has a slider from 100% to 200%, in steps of 25%.

```js
await startBrowser({ screenScale: 200 });
await setBrowserScreenScale(browserId, 100);
await setBrowserScreenScale(browserId, null); // 150% again
```

The scale is in percent, from 100% to 300%, in steps of 25%. See `src/vm/screen-scale.js`.

The screen keeps its size in pixels, so at 150%, a 1920×1080 screen shows pages as if it were 1280×720, with sharper text. The browser keeps running, with its pages and CDP connections, and follows the new scale without a restart. In a page, `devicePixelRatio` is the scale, e.g. `1.5`. Nothing outside the guest shows the change, so `setBrowserScreenScale` returns once the guest has the new value, and the browser follows a moment later.

The app writes the scale, such as `150`, or `default`, as one line into a file in the guest, through the guest agent, after the screen size. As for the screen size, the app sets the scale before the browser starts at launch, the setting stays across a suspend and resume, and a file without exactly one valid line leaves the scale as it is.

### Linux

1. The app writes the scale into `/etc/remotebrowser/screen-scale`.
2. `screen-scale.path` sees the change, and `/usr/local/bin/screen-scale` sets the labwc output scale to it with `wlr-randr`.
3. Chromium runs natively on Wayland, and follows the new scale at once, through the fractional scale protocol. labwc forgets the scale when it restarts, so `display.service` sets it again.

Check it with `wlr-randr`, as above, or `journalctl -u screen-scale`.

### Windows

1. The app writes the scale into `C:\ProgramData\remotebrowser\screen-scale`.
2. `screen-scale.ps1` runs in the session of the `browser` account, since the scale belongs to that session. It sets the scale as the Settings app does, so Windows and its apps follow at once, without a sign-out.

Windows offers 100%, 125%, 150%, 175%, 200%, 225%, 250%, and 300%, but no 275%, so that scale leaves the screen as it is. Windows also caps the scale by the screen size. For a scale above that cap, the screen gets the largest one Windows offers for its size. For example, at 1920×1080, the largest is 175%, so a scale of 200% gives 175%. At 2560×1440, it gives 200%.

Windows keeps the scale as a step up or down from the one it recommends for the screen size, so a new size could change it. The script sets the scale again every second, so the screen keeps the scale that the host asked for.
