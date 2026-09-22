# MontageAI account architecture

## Document status

This is a **target architecture**, not a checklist of features already deployed.
The current implementation is hybrid: accounts/projects use the account store,
while queue/status/action artifacts still use S3 JSON and the local executor keeps
job artifacts on Windows. The entity list and recommended S3 layout below are a
destination, not an assertion that those tables and object paths all exist today.

For implemented local changes, rollout boundaries and current limitations, see
[commercial hardening](COMMERCIAL_HARDENING.md). Work and verification status are
tracked separately in [the commercial backlog](COMMERCIAL_BACKLOG.md).

## Decision

MontageAI uses Timeweb Cloud as the control plane for the web product:

- **App Platform** serves the web interface and Node.js API from one HTTPS origin;
- **Managed PostgreSQL** is the source of truth for users, sessions, projects,
  revisions, approvals and worker leases;
- **private S3** stores source videos, previews and final files;
- the **MontageAI worker** performs transcription and rendering outside HTTP
  requests. It stays on the Windows machine during the MVP and may later move
  to a dedicated CPU/GPU server.

The web application must never execute Whisper or FFmpeg synchronously inside
an API request. The API accepts a file, records a job and returns immediately;
the worker claims the job and reports progress independently.

## Why the current upload token is not an account

The existing signed link grants temporary access to one job. It is useful for
Telegram links and for migration, but it has no durable user identity, project
history, revocable sessions or password recovery. It must remain a compatibility
path, not become the account system.

## Identity and sessions

Production account sessions use an opaque random token in an
`HttpOnly; Secure; SameSite=Lax` cookie. PostgreSQL stores only a SHA-256 hash
of that token. A browser never supplies `user_id`; the API derives ownership
from the validated session.

Initial authentication supports email and password. Passwords are derived with
Node.js `scrypt` using an independent random salt and a timing-safe comparison.
Email verification and password recovery require a transactional-email provider
and are a separate rollout step. Telegram is linked later using a one-time code
and the numeric Telegram user ID, never a username.

## Ownership model

Every project belongs to exactly one user. All project, pipeline, revision,
approval and download endpoints must load the user from the server session and
then check project ownership. A project ID sent by a browser is only an object
identifier; it is never authorization.

Recommended S3 layout:

```text
users/<user_id>/projects/<project_id>/uploads/<upload_id>/source.mov
users/<user_id>/projects/<project_id>/previews/v1.mp4
users/<user_id>/projects/<project_id>/previews/v2.mp4
users/<user_id>/projects/<project_id>/final/v2.mp4
```

Preview keys are immutable. Approval binds to a specific preview version and
checksum. Creating a newer preview revokes the earlier approval. Publication
remains impossible without a current explicit user approval.

## Data boundaries

PostgreSQL stores structured state and relationships. S3 stores binary media and
optional JSON audit artifacts. The Windows worker keeps its deterministic local
job state in SQLite/JSON, but that local state is not the web account database.

Minimum PostgreSQL entities:

- `users`
- `sessions`
- `projects`
- `uploads`
- `jobs`
- `preview_versions`
- `revisions`
- `approvals`
- `telegram_links`
- `audit_events`
- `worker_leases`

## Migration without breaking current users

1. Serve the interface and API from the same Timeweb HTTPS domain.
2. Connect PostgreSQL and run idempotent migrations.
3. Enable registration, login, `/api/auth/me` and logout.
4. Create every new web project with an authenticated owner.
5. Keep legacy Telegram/job links working during the transition.
6. Allow a signed legacy job to be attached to an account only while its old
   token is valid.
7. Move status writes to PostgreSQL while retaining S3 JSON as audit artifacts.
8. Introduce immutable preview versions and version-bound approval.
9. Replace global queue scans with transactional worker leases and heartbeats.
10. Disable legacy bearer links after the migration window.

## Production checklist

- App and API use one domain and HTTPS.
- `DATABASE_URL` uses TLS and is available only to the backend.
- Session and token secrets are independent, random and never exposed to the
  frontend or logs.
- S3 bucket is private; clients receive short-lived signed URLs only.
- Registration/login endpoints have persistent rate limits and bot protection.
- Uploaded object size and checksum are verified after multipart completion.
- Worker runs with least privilege, resource/time limits and an isolated work
  directory.
- Security headers, audit events, backups and restore testing are enabled.
- No route can publish a video unless the selected preview version has explicit
  approval.

## Timeweb fit

Timeweb is a good MVP host for the web interface, API, managed PostgreSQL and S3.
App Platform is not the right place to assume heavy, long-running Whisper and
FFmpeg workloads. Keeping rendering in a separate worker lets the control plane
remain responsive and makes a later move from Windows to a dedicated CPU/GPU
server incremental rather than a rewrite.

Official references used for this decision:

- [App Platform architecture](https://timeweb.cloud/docs/apps/how-it-works)
- [Backend deployment](https://timeweb.cloud/docs/apps/deploying-backend-applications)
- [Managed PostgreSQL creation](https://timeweb.cloud/docs/dbaas/dbaas-create)
- [S3 API and supported operations](https://timeweb.cloud/docs/s3-storage/manage-storage/s3-guide)
- [App Platform reverse-proxy limits](https://timeweb.cloud/docs/apps/reverse-proxy)
- [GPU servers](https://timeweb.cloud/services/gpu)
