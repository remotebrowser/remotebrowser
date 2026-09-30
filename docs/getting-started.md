# Getting Started

At the moment, Remote Browser depends on [Podman Fleet](https://github.com/remotebrowser/podman-fleet) to run containerized Google Chrome. This may change in the future.

First, follow the instructions in the [Podman Fleet repository](https://github.com/remotebrowser/podman-fleet). In short, you need [Podman](https://podman.io), [Python](https://www.python.org) with [uv](https://docs.astral.sh/uv), and you start it with `make`. After a few seconds, Podman Fleet will run at `localhost:8400`. Open that URL to check its simple web interface.

Next, start Remote Browser. You need the latest [Node.js LTS](https://nodejs.org):

```bash
export BROWSERFLEET_URL=http://127.0.0.1:8400
npm install && npm start
```

Then open `localhost:3000`.

Sign in with any email address. This is a development version, so it does not send a real "magic link". Instead, the link is printed in the application output. Find the link and open it to continue.
