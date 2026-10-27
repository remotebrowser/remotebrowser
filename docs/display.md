# Display

The browser runs on a virtual screen from [Xvnc](https://tigervnc.org), inside each VM. By default, the screen is 1920×1080, at a scale of 150%. [Openbox](https://openbox.org), a small window manager, keeps the browser window maximized on it.

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

The width and height are in pixels, from 640×480 to 3840×2160. See `src/vm/screen-resolution.js`. Only local VMs have this; with `BROWSERFLEET_URL`, the calls answer `NOT_SUPPORTED`.

A new size takes effect at once. The browser keeps running, with its pages and CDP connections, and its window stays maximized on the new screen. `setBrowserScreenResolution` returns once the screen has the new size, so the next screenshot already has it.

How it works:

1. The app writes the size, such as `1366x768`, or `default`, as one line into `/etc/remotebrowser/screen-resolution` in the guest, through the guest agent.
2. `screen-resolution.path` sees the change, and `/usr/local/sbin/screen-resolution` sets the Xvnc screen to it with `xrandr`. Only numbers go into the commands. The app waits until the VNC handshake reports the new size.
3. Openbox sees the new screen and resizes the maximized window to fit. Chromium starts with `--start-maximized`, which needs a window manager to do anything.

At launch, the app sets the size before it sets the clock, which starts the browser (see `chromium-start.timer`), so the browser starts on that screen. The setting is on the VM's disk, so it stays across a suspend and resume. If the file does not hold exactly one valid line, for example after a write that did not finish, the screen keeps its size. Xvnc starts at 1920×1080, for example after a crash, and sets the screen size again right after.

Check it in the VM's root shell with `DISPLAY=:99 xrandr`, or `journalctl -u screen-resolution -u openbox`.

## Screen scale

The browser can also scale its pages and its own controls, like a desktop set to 125%. By default, the scale is 150%. The launch page has a slider from 100% to 200%, in steps of 25%.

```js
await startBrowser({ screenScale: 200 });
await setBrowserScreenScale(browserId, 100);
await setBrowserScreenScale(browserId, null); // 150% again
```

The scale is in percent, from 100% to 300%, in steps of 25%. See `src/vm/screen-scale.js`. Only local VMs have this; with `BROWSERFLEET_URL`, the calls answer `NOT_SUPPORTED`.

The screen keeps its size in pixels, so at 150%, a 1920×1080 screen shows pages as if it were 1280×720, with sharper text. The browser keeps running, with its pages and CDP connections, and follows the new scale without a restart. In a page, `devicePixelRatio` is the scale, e.g. `1.5`. Nothing outside the guest shows the change, so `setBrowserScreenScale` returns once the guest has the new value, and the browser follows a moment later.

How it works:

1. The app writes the scale, such as `150`, or `default`, as one line into `/etc/remotebrowser/screen-scale` in the guest, through the guest agent.
2. `screen-scale.path` sees the change, and `/usr/local/sbin/screen-scale` writes the matching DPI, 96 for each 100%, into `/etc/remotebrowser/xsettingsd.conf`, then tells [xsettingsd](https://codeberg.org/derat/xsettingsd) to read it again.
3. xsettingsd shares the new DPI (`Xft/DPI`) with the X clients on the display. Chromium follows it at once, through GTK.

As for the screen size, the app sets the scale before the clock at launch, the setting stays across a suspend and resume, and a file without exactly one valid line leaves the scale as it is.

Check it in the VM's root shell with `cat /etc/remotebrowser/xsettingsd.conf`, or `journalctl -u screen-scale -u xsettingsd`.
