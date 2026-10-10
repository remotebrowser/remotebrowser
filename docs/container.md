# Container

Remote Browser runs each Google Chrome browser in its own isolated container.
It supports either [Podman](https://podman.io) or [Docker](https://www.docker.com). Set `CONTAINER_RUNTIME` to `podman` or `docker`, or leave it unset and the app will auto-detect the runtime ([Podman](https://podman.io) first, then [Docker](https://www.docker.com)). The chosen CLI must be installed and available on the `PATH` of the user who runs the app.

At startup, the app checks the runtime with its `info` command. If the runtime is not reachable, the app logs the failure and the server still starts, but browsers cannot be provisioned until the runtime is reachable.

Browser containers are named `chrome-<id>` and started with `--rm`, so the runtime removes them when the browser is terminated.

## Remote runtime

By default, the app talks to the local runtime. For a remote [Podman](https://podman.io) socket, set `CONTAINER_HOST` (for example `unix:///run/podman.sock`); the app then runs every command as `podman --remote`. For [Docker](https://www.docker.com), set `DOCKER_HOST` instead. In a containerized deployment, mount the runtime socket into the app container and point the matching variable at its path inside the container.
