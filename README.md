# TowTeam Manager

Private control plane for enrolling and operating independent TowTeam nodes. The
manager can read node health and version information and request signed update,
restart, and backup jobs. It does not provide arbitrary remote shell execution.

> **Private security component:** This repository is not intended for public
> release. It stores credentials capable of controlling enrolled TowTeam nodes.
> Deploy it behind HTTPS and access controls on a trusted administrative network.

The current version is sourced from `package.json`, returned by
`GET /api/health`, and displayed on the login and authenticated screens.

## Requirements

- Node.js 24 or newer for native testing
- Docker with the Compose plugin for container operation
- Git inside supervised installations that use self-updates
- Network access from the manager to every enrolled TowTeam node

## Native Testing

```sh
cp .env.example .env
npm ci
npm run start
```

Open `http://localhost:8090`. Native startup uses
`./data/manager.sqlite`. Leave `MANAGER_UPDATE_ENABLED=false` because a native
Node process has no supervisor to restart it after an update.

If the password and encryption-key placeholders are unchanged, startup generates
private values in `data/initial-admin-password.txt` and
`data/manager-secret.key`. Both files and the SQLite database are ignored by Git.
The initial username defaults to `admin`.

## Docker

```sh
cp .env.example .env
# Review .env and set PUBLIC_ORIGIN to the external HTTPS origin when applicable.
docker compose up -d
docker compose logs -f --tail=100 towteam-manager
```

Open `http://localhost:8090` or the HTTPS address configured through your reverse
proxy. Compose stores the database and generated secrets in the
`towteam_manager_data` volume and dependencies in
`towteam_manager_node_modules`. The source checkout is mounted at `/app` so a
clean fast-forward self-update can modify the checkout before Compose restarts it.
Compose installs Python and the native compiler toolchain before `npm ci` so
`better-sqlite3` can build when a precompiled binary is unavailable. It also
installs the system CA bundle required for verified GitHub HTTPS connections.

The native `./data` directory and Docker named volume are separate manager
installations. Nodes enrolled during native testing do not automatically appear
in the Docker installation.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8090` | HTTP listening port. |
| `HOST` | `0.0.0.0` | Listening address. |
| `DATABASE_URL` | `./data/manager.sqlite` | Native SQLite location; Compose uses `/app/data/manager.sqlite`. |
| `MANAGER_NAME` | `TowTeam Manager` | Name displayed to administrators and enrolled nodes. |
| `MANAGER_ADMIN_USERNAME` | `admin` | Username created only when the database has no users. |
| `MANAGER_ADMIN_PASSWORD` | generated | Initial password; explicit values must be at least 12 characters. |
| `MANAGER_SECRET_KEY` | generated | 64-character hexadecimal key used to encrypt node tokens. |
| `PUBLIC_ORIGIN` | same origin | Optional fixed HTTPS origin used for request and cookie security. |
| `TRUST_PROXY` | `0` | Express proxy-hop setting for a trusted reverse proxy. |
| `MANAGER_UPDATE_ENABLED` | `false` | Enables self-updates in a supervised standalone Git checkout. |
| `BULK_UPDATE_CONCURRENCY` | `3` | Maximum simultaneous node updates, clamped from 1 through 10. |

Changing `MANAGER_SECRET_KEY` after enrollment makes stored node credentials
unreadable. Back up the key with the manager database and never commit it.

## Enroll A Node

1. Sign in to the TowTeam node as Local Administrator.
2. Open **Administration > Backup**.
3. Set a station name and enable remote management.
4. Create a one-time enrollment key. It expires after 20 minutes and can be used once.
5. In TowTeam Manager, choose **Add node** and enter the node URL and key.

The node returns a machine token once. The manager encrypts it at rest with
`MANAGER_SECRET_KEY`; the node stores only its SHA-256 hash. Normal TowTeam user,
tow, and paper APIs are not available to machine credentials.

## Node Operations

The Nodes screen uses server-side search and pagination. Search matches station
name, URL, UUID, installed version, release channel, and online/offline state.
Page sizes of 10, 25, 50, and 100 are available; the default is 25.

- **Refresh** reads node identity, version, uptime, release channel, and update state.
- **Check update** asks the node to inspect its configured Git release channel.
- **Update** requests a clean fast-forward update and supervised restart.
- **Update all nodes** starts a background job for every enrolled node, independent
  of the current search. Progress and per-node failures are tracked by the manager.
- **Restart** exits the node process and requires Docker or another supervisor.
- **Backup** creates a point-in-time SQLite backup on the node.
- **Remove** removes the node locally. Revoke its credential from the node as well.

Every manager action is recorded locally. Nodes also record signed jobs in their
management job table and normal audit log.

## Manager Self-Updates

The **Manager** tab provides clean fast-forward updates for this service. It requires:

- `MANAGER_UPDATE_ENABLED=true`
- this directory to be the root of its own Git checkout
- a configured upstream branch
- a clean checkout with no local commits ahead of upstream
- Docker Compose or another supervisor capable of restarting the process

After pulling, new `.env.example` keys are appended to `.env` without replacing
existing values. A timestamped `.env.pre-update-*` backup is retained whenever
keys are added. The manager exits and relies on its supervisor to restart.

## Data And Recovery

Back up these items together:

- a consistent backup of `manager.sqlite`, not a live file copy
- `manager-secret.key`, or the externally configured `MANAGER_SECRET_KEY`
- the active `.env`

The database contains administrator password hashes, sessions, encrypted node
tokens, node metadata, and the audit trail. Losing the encryption key requires
re-enrolling all nodes.

## API Summary

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `GET /api/health` | Public | Manager health, name, and version. |
| `POST /api/login` | Rate limited | Create an administrator session. |
| `GET /api/me` | Authenticated | Current administrator and manager version. |
| `GET /api/nodes` | Authenticated | List enrolled nodes. |
| `POST /api/nodes/enroll` | Authenticated | Consume a node enrollment key. |
| `POST /api/nodes/:id/refresh` | Authenticated | Refresh node status. |
| `POST /api/nodes/:id/jobs` | Authenticated | Send an allowed signed job. |
| `DELETE /api/nodes/:id` | Authenticated | Remove a node from this manager. |
| `GET /api/audit` | Authenticated | Paginated management audit entries. |
| `GET /api/updates` | Authenticated | Check this manager's upstream. |
| `POST /api/updates/install` | Authenticated | Install a manager update and restart. |

## Development

```sh
npm ci
npm run lint
npm test
npm run build
```

`npm run dev` starts Node in watch mode. CI runs ESLint, tests, syntax/build
checks, and a Docker image build. The Security workflow runs a production npm
audit, CodeQL, and Gitleaks. Dependabot monitors npm and GitHub Actions weekly.

See [SECURITY.md](SECURITY.md) before operating the manager or reporting a
vulnerability.
