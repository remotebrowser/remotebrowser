# Getting Started

You need the latest [Node.js LTS](https://nodejs.org) and a working [Podman](https://podman.io) or [Docker](https://www.docker.com) installation.

Verify that the `podman` (or `docker`) CLI is on your `PATH` and can run containers:

```bash
podman info    # or: docker info
```

Pull the browser image once, so the first launch is fast:

```bash
podman pull ghcr.io/remotebrowser/chrome-live
```

Then start Remote Browser:

```bash
npm install && npm start
```

Then open `localhost:3000`.

Sign in with any email address. This is a development version, so it does not send a real "magic link". Instead, the link is printed in the application output. Find the link and open it to continue.

Launch a new browser and follow the on-screen instructions. The video below shows a coding assistant using Remote Browser to go to Amazon, sign in, search for a specific product, and extract its detailed customer reviews.

<iframe width="560" height="315" src="https://www.youtube.com/embed/w3pg9wJhfqY" title="Remote Browser demo" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
