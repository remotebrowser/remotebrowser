# Container

Remote Browser runs each Google Chrome browser in its own isolated container.
It supports either [Podman](https://podman.io) or [Docker](https://www.docker.com). Set `CONTAINER_RUNTIME` to `podman` or `docker`, or leave it unset and the app will auto-detect the runtime (Podman first, then Docker). The chosen CLI must be installed and available on the `PATH` of the user who runs the app.

Browser containers are named `chrome-<id>` and started with `--rm`, so the runtime removes them when the browser is terminated.

## Docker

At startup, the app checks the runtime with `docker info`. If it is not reachable, the app logs the failure and the server still starts, but browsers cannot be provisioned until it is reachable.

Install [Docker](https://www.docker.com), make sure the `docker` CLI is on the `PATH` of the user who runs the app, and set `CONTAINER_RUNTIME=docker`. If it is unset, the app uses Docker only when Podman is not found.

By default, the app talks to the local Docker daemon. For a remote daemon, set `DOCKER_HOST` (for example `unix:///var/run/docker.sock` or `tcp://host:2375`).

In a containerized deployment, mount the Docker socket into the app container and set `DOCKER_HOST` to its path inside the container.

## Podman

At startup, the app checks the runtime with `podman info`. If it is not reachable, the app logs the failure and the server still starts, but browsers cannot be provisioned until it is reachable.

Install [Podman](https://podman.io), make sure the `podman` CLI is on the `PATH` of the user who runs the app, and set `CONTAINER_RUNTIME=podman`. If it is unset, the app prefers Podman whenever it is found.

By default, the app talks to the local Podman runtime. For a remote Podman socket, set `CONTAINER_HOST` (for example `unix:///run/podman.sock`); the app then runs every command as `podman --remote`.

In a containerized deployment, mount the Podman socket into the app container and set `CONTAINER_HOST` to its path inside the container.
