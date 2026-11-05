# Security Policy

TowTeam Manager is a private control-plane service with permission to request
updates, restarts, and backups from enrolled TowTeam nodes. Do not expose it
directly to the public internet or publish node credentials, enrollment keys,
manager databases, environment files, or generated secret files.

Report suspected vulnerabilities privately to the repository owner. Do not open
a public issue containing credentials, deployment URLs, logs with bearer tokens,
or reproduction steps that could affect a live managed node.

Before reporting, preserve relevant audit entries but redact passwords, session
cookies, enrollment keys, machine tokens, and `MANAGER_SECRET_KEY`.
