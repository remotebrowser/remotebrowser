# Getting Started

To try Remote Browser locally, use [Docker](https://www.docker.com/products/docker-desktop/) or [Podman](https://podman.io).

For a production deployment, see the [Self-Hosting Guide](self-hosting.md).

## Docker

Check that Docker is running:

```bash
docker info
```

If the command fails, start the Docker daemon. On Windows or macOS, open [Docker Desktop](https://www.docker.com/products/docker-desktop/) and wait for it to start. On Linux, run `sudo systemctl start docker`.

Get the Docker socket's group ID:

```bash
SOCK_GID=$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  docker.io/library/alpine stat -c '%g' /var/run/docker.sock)
```

Start a [Postgres](https://www.postgresql.org) database. The following command runs it in Docker:

```bash
docker run -d --name rb-pg -p 5433:5432 \
  -e POSTGRES_USER=remotebrowser \
  -e POSTGRES_PASSWORD=remotebrowser \
  -e POSTGRES_DB=remotebrowser \
  docker.io/library/postgres:17-alpine
```

Set the database connection details:

```bash
export DB=remotebrowser
export DATABASE_URL="postgres://${DB}:${DB}@host.docker.internal:5433/${DB}"
```

Pull the browser image before launching Remote Browser. This makes the first launch faster:

```bash
docker pull ghcr.io/remotebrowser/chrome-live
```

Start Remote Browser and connect it to the database:

```bash
docker run --rm -it -p 3000:3000 \
  --security-opt label=disable \
  --add-host=host.docker.internal:host-gateway \
  --group-add "${SOCK_GID}" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e NODE_ENV=development \
  -e CONTAINER_RUNTIME=docker \
  -e DOCKER_HOST=unix:///var/run/docker.sock \
  -e DATABASE_URL \
  ghcr.io/remotebrowser/remotebrowser
```

Then open `localhost:3000`.

Sign in with any email address. Because this setup has no SMTP server, it cannot email you a sign-in link. The server prints the link to its console. Open that link to continue.

## Podman

Check that Podman is running:

```bash
podman info
```

If the command fails, start the Podman service. On Windows or macOS, open [Podman Desktop](https://podman-desktop.io/) and wait for it to start. On Linux, run `systemctl --user start podman.socket`.

Start a [Postgres](https://www.postgresql.org) database. The following command runs it in Podman:

```bash
podman run -d --name rb-pg -p 5433:5432 \
  -e POSTGRES_USER=remotebrowser \
  -e POSTGRES_PASSWORD=remotebrowser \
  -e POSTGRES_DB=remotebrowser \
  docker.io/library/postgres:17-alpine
```

Set the database connection details:

```bash
export DB=remotebrowser
export DATABASE_URL="postgres://${DB}:${DB}@host.containers.internal:5433/${DB}"
```

Start Remote Browser and connect it to the database:

```bash
podman run --rm -it -p 3000:3000 \
  --userns=keep-id \
  --security-opt label=disable \
  -v /run/user/1000/podman/podman.sock:/run/podman/podman.sock \
  -e NODE_ENV=development \
  -e CONTAINER_HOST=unix:///run/podman/podman.sock \
  -e DATABASE_URL \
  ghcr.io/remotebrowser/remotebrowser
```

Then open `localhost:3000`.

Sign in with any email address. Because this setup has no SMTP server, it cannot email you a sign-in link. The server prints the link to its console. Open that link to continue.

## Node.js

To run the latest development version of Remote Browser from source, you need the latest [Node.js LTS](https://nodejs.org) and [Docker](https://www.docker.com/products/docker-desktop/).

Check that Docker is available and can run containers:

```bash
docker info
```

Pull the browser image before launching Remote Browser. This makes the first launch faster:

```bash
docker pull ghcr.io/remotebrowser/chrome-live
```

Start Remote Browser:

```bash
export CONTAINER_RUNTIME=docker
npm install
npm start
```

Then open `localhost:3000`.

Sign in with any email address. Because this setup has no SMTP server, it cannot email you a sign-in link. The server prints the link to its console. Open that link to continue.

Start a browser session and follow the on-screen instructions. The video below shows a coding assistant using Remote Browser to sign in to Amazon, find a product, and read its customer reviews.

<iframe width="560" height="315" src="https://www.youtube.com/embed/w3pg9wJhfqY" title="Remote Browser demo" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>

If you use [Podman](https://podman.io), replace `docker` with `podman` in the commands and set `CONTAINER_RUNTIME=podman`.
