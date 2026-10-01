# Remote Browser

First, run [Podman Fleet](https://github.com/remotebrowser/podman-fleet) – it provides the browser instances that Remote Browser controls.

Then, launch Remote Browser pointing to it:

```bash
export BROWSERFLEET_URL=http://127.0.0.1:8400
npm install
npm start
```

Finally, visit `http://127.0.0.1:3000`.
