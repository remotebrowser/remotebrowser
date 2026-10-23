# Getting Started

!!! warning "macOS"

    To try Remote Browser locally on macOS, run it from source. Refer to the [development setup for macOS](setup.md#macos).

To try Remote Browser locally on Linux, you need [KVM](https://linux-kvm.org), [Docker](https://www.docker.com), and [Postgres](https://www.postgresql.org).

Check that your user can access KVM:

```bash
test -r /dev/kvm -a -w /dev/kvm && echo "KVM is ready"
```

If the check fails, add your user to the `kvm` group. Then log out, log back in, and run the check again.

Check that Docker works:

```bash
docker info
```

Remote Browser stores its data in Postgres. You can use a Postgres server that is installed on your system, or run one in Docker:

```bash
docker run -d --name rb-pg -p 5433:5432 \
  -e POSTGRES_USER=remotebrowser \
  -e POSTGRES_PASSWORD=remotebrowser \
  -e POSTGRES_DB=remotebrowser \
  docker.io/library/postgres:17-alpine
```

Set the database connection details. For the example above:

```bash
export DB=remotebrowser
export DATABASE_URL="postgres://${DB}:${DB}@host.docker.internal:5433/${DB}"
```

Create a directory for the browser virtual machines:

```bash
mkdir -p .data/vm
```

Start Remote Browser:

```bash
docker run --rm -it -p 3000:3000 \
  --security-opt label=disable \
  --add-host=host.docker.internal:host-gateway \
  --user "$(id -u):$(id -g)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  --device /dev/kvm \
  --group-add "$(stat -c '%g' /dev/kvm)" \
  -v "$PWD/.data/vm:/app/.data/vm" \
  -e NODE_ENV=development \
  -e DATABASE_URL \
  ghcr.io/remotebrowser/remotebrowser
```

At startup, Remote Browser builds the VM image and saves a snapshot of a booted VM. The first start takes a few minutes, but later starts are quick.

When the server is ready, open `http://localhost:3000` in your browser.

Sign in with any email address. This setup has no SMTP server, so it cannot email you the sign-in link. Instead, the server prints the link to its console. Open that link to continue.

To try a simple automation, launch a browser. Its page opens with the [Playground](playground.md), which lets you run code against the live browser and watch the result.

![Playground](playground.jpg){: style="width: 505px; max-width: 100%; height: auto; border: 1px solid darkgray" }

!!! warning

    Access to the Docker socket gives full control of the host. This is fine for a quick try, but not for a server that others use. To run the server without the socket, see [VM image](self-hosting.md#vm-image).
