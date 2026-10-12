# Getting Started

To quickly try a non-production version of Remote Browser, you need [Podman](https://podman.io) or [Docker](https://www.docker.com).

To deploy the production version, see the [Self-Hosting Guide](self-hosting.md).

## Podman

Start the Podman socket. Remote Browser mounts it into the container to launch browsers:

```bash
systemctl --user start podman.socket
```

Start a [Postgres](https://www.postgresql.org) database. There are many ways to do this, but the easiest is with Podman itself:

```bash
podman run -d --name rb-pg -p 5433:5432 \
  -e POSTGRES_USER=remotebrowser \
  -e POSTGRES_PASSWORD=remotebrowser \
  -e POSTGRES_DB=remotebrowser \
  docker.io/library/postgres:17-alpine
```

Finally, launch Remote Browser connected to that database:

```bash
export DB=remotebrowser
podman run --rm -it --network host --userns=keep-id \
  --security-opt label=disable \
  -v /run/user/1000/podman/podman.sock:/run/podman/podman.sock \
  -e NODE_ENV=development \
  -e CONTAINER_HOST=unix:///run/podman/podman.sock \
  -e DATABASE_URL="postgres://${DB}:${DB}@127.0.0.1:5433/${DB}" \
  ghcr.io/remotebrowser/remotebrowser
```

Then open `localhost:3000`.

Sign in with any email address. This is a non-production version without a configured SMTP server, so it does not send a real "magic link". Instead, the link is printed to the server console. Find the link and open it to continue.

## Docker

Make sure the Docker daemon is running:

```bash
sudo systemctl start docker
```

Start a [Postgres](https://www.postgresql.org) database. There are many ways to do this, but the easiest is with Docker itself:

```bash
docker run -d --name rb-pg -p 5433:5432 \
  -e POSTGRES_USER=remotebrowser \
  -e POSTGRES_PASSWORD=remotebrowser \
  -e POSTGRES_DB=remotebrowser \
  docker.io/library/postgres:17-alpine
```

Finally, launch Remote Browser connected to that database:

```bash
export DB=remotebrowser
docker run --rm -it --network host \
  --security-opt label=disable \
  --group-add $(stat -c '%g' /var/run/docker.sock) \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e NODE_ENV=development \
  -e CONTAINER_RUNTIME=docker \
  -e DOCKER_HOST=unix:///var/run/docker.sock \
  -e DATABASE_URL="postgres://${DB}:${DB}@127.0.0.1:5433/${DB}" \
  ghcr.io/remotebrowser/remotebrowser
```

Then open `localhost:3000`.

Sign in with any email address. This is a non-production version without a configured SMTP server, so it does not send a real "magic link". Instead, the link is printed to the server console. Find the link and open it to continue.

## Node.js

To try the latest bleeding-edge development version of Remote Browser, you need the latest [Node.js LTS](https://nodejs.org) and a working [Podman](https://podman.io) or [Docker](https://www.docker.com) installation. The following instructions are for Podman; for Docker, substitute accordingly.

First, verify that the container CLI is on your `PATH` and can run containers:

```bash
podman info
```

Pull the browser image once, so the first launch is fast:

```bash
podman pull ghcr.io/remotebrowser/chrome-live
```

Then start Remote Browser:

```bash
export CONTAINER_RUNTIME=podman
npm install
npm start
```

Then open `localhost:3000`.

Sign in with any email address. This is a development version without a configured SMTP server, so it does not send a real "magic link". Instead, the link is printed to the server console. Find the link and open it to continue.

Launch a new browser and follow the on-screen instructions. The video below shows a coding assistant using Remote Browser to open Amazon, sign in, search for a specific product, and extract its detailed customer reviews.

<iframe width="560" height="315" src="https://www.youtube.com/embed/w3pg9wJhfqY" title="Remote Browser demo" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
