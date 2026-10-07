# User request inbox

Agents sometimes get blocked on you while you are away from T3 Code. They might need a
decision, an action only you can take, a written answer, or time on your calendar. A
question asked in chat only reaches you if you are watching that thread. A user request
inbox gives agents a channel that outlives the session. The agent files the request
with `t3_user_request_create` and keeps working on whatever does not depend on the
answer. You answer from wherever your inbox lives, such as your phone, and the agent
reads the verdict with `t3_user_request_status`.

The feature is off by default. With nothing configured, T3 Code behaves exactly as
before, and both tools fail with `capability_denied`.

## Why the inbox lives outside T3 Code

T3 Code does not store or display these requests. It forwards them to an HTTP service
that you run or choose. You then get one place to triage requests from every agent and
machine, including agents that do not run in T3 Code. That place is reachable when the
T3 Code host is asleep, and it can do things T3 Code cannot, such as adding the
approved block to your calendar or task list. The protocol is small, so you can write
your own inbox.

## Setup

Set these environment variables for the T3 Code **server** process, then restart it.

| Variable                               | Required | Meaning                                                                                                                                                           |
| -------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T3CODE_USER_REQUEST_INBOX_URL`        | yes      | The inbox endpoint, e.g. `https://inbox.example.com/api/agent/asks`. It must use `https`. Plain `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]`. |
| `T3CODE_USER_REQUEST_INBOX_TOKEN_FILE` | yes      | Path to a file that holds the bearer token.                                                                                                                       |
| `T3CODE_USER_REQUEST_LINK_ORIGIN`      | no       | An origin your phone can open, e.g. your tailnet or T3 Connect web address. When set, each request carries a link back to the filing thread.                      |

T3 Code reads the settings on every call, not at startup. A mistake never stops the
server from booting, and you can fix the token file without a restart.

### Why the token is a file

T3 Code passes its whole environment to every provider process it starts (Claude,
Codex, Cursor, and the rest). A token in a `T3CODE_*` variable would be readable by
every agent and could end up in transcripts. A file path is harmless to inherit, so
T3 Code reads the token from the file only when it sends a request.

The file must contain one token of at least 32 characters from `A–Z a–z 0–9 _ -`.
Surrounding whitespace is ignored. On macOS and Linux, T3 Code refuses a token file
that its group or other users can read:

```bash
printf '%s' "$TOKEN" > ~/.t3-user-request-inbox-token
chmod 600 ~/.t3-user-request-inbox-token
```

On Windows, keep the file in your user profile:

```powershell
Get-Clipboard | Set-Content -NoNewline "$HOME/.t3-user-request-inbox-token"
```

### The deep-link origin

Every request carries `provenance.t3.path`, which is
`/<environmentId>/<threadId>`, both URL-encoded. If `T3CODE_USER_REQUEST_LINK_ORIGIN`
is set, T3 Code also sends `provenance.t3.link`, which is that origin followed by the
path. An inbox can then show an **Open thread** button. Use an origin the device you
answer from can reach. A loopback address only works on the T3 Code host. An origin
that is not a plain `http(s)` URL is ignored.

## What agents see

- **`t3_user_request_create`** files a request and returns right away with an `id`.
  The `kind` field is one of the following:
  - `decide`, with 2–6 `options`;
  - `do`, an action for you to take;
  - `reply`, a written answer;
  - `calendar`, a time block described by `when`.

  T3 Code attaches the thread title, project, branch, model, provider, and the thread
  link.

- **`t3_user_request_status`** reads a request by `id`. With `waitSeconds` (0–600),
  it keeps checking every 5 seconds while the request is still pending, and returns as
  soon as a verdict arrives or the time runs out. Each call returns within
  `waitSeconds` plus 10 seconds, even when the inbox is slow. Codex calls MCP tools
  with a timeout of about 60 seconds, so agents there should keep `waitSeconds` at 45
  or below.

Only a thread's own agent can file a request, and only while that thread has an
active run. OAuth clients connected without a thread credential cannot use either
tool.

Failures come back as tool errors with fixed messages. A message never contains the
inbox URL, the token, the token-file path, or the inbox's response body.

| Situation                                                                             | Tool error code       |
| ------------------------------------------------------------------------------------- | --------------------- |
| Not configured, or configured unsafely (non-https URL, readable token file)           | `capability_denied`   |
| The inbox refused the request (4xx, or 503 `agent-api-off`); unknown request id       | `invalid_request`     |
| Rate-limited or full (429); unreachable, timed out, redirected, 5xx, unreadable reply | `orchestration_error` |

## Provider and connection coverage

The tools are part of T3 Code's `t3-code` MCP server. Every provider session that
T3 Code connects to that server gets them:

- **Claude**, through the `mcp__t3-code__*` permission wildcard;
- **Codex, Cursor, ACP agents and Pi**, which list T3 Code's tools dynamically;
- **OpenCode**, when T3 Code manages the OpenCode server. OpenCode pointed at an
  external server gets no `t3-code` tools, including these.

In remote and T3 Connect setups, the **T3 Code server host** calls the inbox, not the
device you are using. Set the variables and the token file on that host, and make
sure it can reach the inbox URL.

## The `user-request-inbox/1` protocol

An inbox needs two endpoints. Every call carries `Authorization: Bearer <token>`.
T3 Code does not follow redirects; any `3xx` counts as a failure. Responses larger
than 64 KB, or slower than 10 seconds, also count as failures.

### Create: `POST <url>`

Headers: `Content-Type: application/json`, `Accept: application/json`, and
`Idempotency-Key`, which is set to the same value as the body's `clientRequestId`.

```json
{
  "protocol": "user-request-inbox/1",
  "clientRequestId": "t3:4be0c6f1d2a9...",
  "kind": "calendar",
  "title": "Review the migration plan with me",
  "body": "I need 50 minutes to walk through the schema change before I run it.",
  "urgency": "today",
  "blocking": true,
  "when": { "start": "2026-10-08T14:00", "durationMin": 50, "timeZone": "America/New_York" },
  "pomodoros": 2,
  "provenance": {
    "via": "t3-tool",
    "app": "t3code",
    "appVersion": "0.0.46",
    "agent": "claude",
    "model": "…",
    "machine": "Desktop",
    "cwd": "/Users/me/src/app",
    "branch": "feat/migration",
    "sessionId": "…",
    "t3": {
      "environmentId": "…",
      "threadId": "…",
      "threadTitle": "Plan the schema migration",
      "projectTitle": "app",
      "workspaceRoot": "/Users/me/src/app",
      "path": "/<environmentId>/<threadId>",
      "link": "https://my-host.tailnet.ts.net/<environmentId>/<threadId>",
      "match": "tool"
    }
  }
}
```

Other optional fields are `options` and `allowOther` (decide only), `effortMinutes`,
`destinations` (inbox-specific routing hints, passed through unchanged) and `links`
(`[{label, url}]`, up to 5). Times in `when` are wall-clock `YYYY-MM-DDTHH:MM` in
`when.timeZone`, with no offset. When an agent gives `when.start`, T3 Code fills in
the server's time zone if the agent omitted one, and sets `durationMin: 50` if the
agent gave neither `end` nor `durationMin`. Provenance is display-only and untrusted.
T3 Code strips control and bidi characters from it and truncates each string, and an
inbox should do the same.

**Idempotency.** T3 Code sends
`"t3:" + hex(sha256(namespace + "\n" + key)).slice(0, 40)`. The namespace is the
calling thread's MCP namespace. The key is the agent's own `clientRequestId` when it
gives one. Otherwise the key is the canonical JSON of the request content. A retry
therefore carries the same key, and T3 Code retries once, with the same key, after a
network failure. An inbox should answer as follows:

| Case                        | Response                                                                    |
| --------------------------- | --------------------------------------------------------------------------- |
| New request                 | `201` with the request view and `"created": true`                           |
| Same key, same content      | `200` with the existing request and `"created": false`; never a second copy |
| Same key, different content | `409` with `{"error": "key-reused"}`; the existing request is unchanged     |

### Read: `GET <url>/<id>`

The response is the same request view that create returns. T3 Code needs `id` and
`status` and reads these other fields when they are present:

```json
{
  "id": "4q1r0b7c2d",
  "status": "approved",
  "decided": true,
  "outcomePending": false,
  "done": null,
  "note": "Make it 3pm instead.",
  "choice": null,
  "answer": null,
  "final": {
    "title": "Review the migration plan with me",
    "when": {
      "start": "2026-10-08T15:00",
      "end": "2026-10-08T15:50",
      "timeZone": "America/New_York"
    },
    "pomodoros": 2,
    "destinations": ["google"]
  },
  "summary": "Approved with changes: moved to Thu Oct 8, 3:00–3:50 PM. Added to Google Calendar. Note: \"Make it 3pm instead.\"",
  "seenAt": "2026-10-07T18:02:11Z",
  "snoozedUntil": null,
  "decidedAt": "2026-10-07T18:03:40Z",
  "reopenedAt": null,
  "url": "https://inbox.example.com/?ask=4q1r0b7c2d",
  "pollAfterSeconds": 0
}
```

The agent sees `final.when` flattened into `final.start`, `end`, `durationMin`,
`date` and `timeZone`. A `url` that is not a plain `http(s)` URL is dropped.

**Statuses:**

- `pending` (waiting, including snoozed);
- `approved`;
- `edited` (approved with changes);
- `declined`;
- `answered`;
- `withdrawn`;
- `expired`.

`decided` is true once a verdict stands. Return `404` for an id the token does not own.

**Settle window.** An inbox can hold a verdict back for a few seconds so you can undo
it. Time Tracker holds verdicts for 10 seconds. While a verdict is held, the inbox
should report the request exactly as if it were still pending: `status: "pending"`,
`decided: false`, with `note`, `choice`, `answer` and `final` set to null. Agents then
never act on a verdict you took back. If you reopen a decision after it became
visible, set `reopenedAt` and return to `pending`. Agents are told that the earlier
verdict no longer stands.

**`outcomePending`** is true while an approved request is still being added where you
chose to put it, such as a calendar or task list. T3 Code's wait loop keeps polling
while it is true, and agents are told to check again after `pollAfterSeconds`.

**`done`** applies to approved `do` requests. It is `false` or `null` until you have
actually done the thing, then `true`. An approved `do` request is scheduled, not done.

**`summary`** is one ready-to-read sentence that agents can quote back to you.

### One channel per token

Each token is a separate channel. A request can only be read with the token that
filed it, and the inbox answers `404` for any other token. Give each machine or app
its own token, so a leaked token exposes only that channel's requests.

### Errors

Error bodies are JSON with an `error` code made of `a-z` and `-`, e.g.
`{"error": "bad-request"}`. T3 Code reports that code to the agent as
`HTTP <status>: <code>`. `429` means busy: include `retryAfterSec` or a
`Retry-After` header, and the agent is told not to refile with new wording. Return
`503` with `{"error": "agent-api-off"}` when the agent API is deliberately disabled.
Any other `5xx` is reported as the inbox being unavailable.

## Example inbox: Time Tracker

Time Tracker is the reference implementation of this protocol. Agents file requests at
`POST /api/agent/asks` and read them at `GET /api/agent/asks/<id>`. Its server reads
the bearer tokens from `ASK_AGENT_TOKENS` as `label:token` pairs, one per machine or
app. Requests appear as cards in an **Asks** panel. Approving a card can add a
Time Tracker task, a Google Calendar event or a Google Task. The agent then sees the
verdict 10 seconds after you decide, worded from what was actually added.

To connect T3 Code, create a token for it (for example with the label `t3dev`), save
it to the token file, and set:

```powershell
$env:T3CODE_USER_REQUEST_INBOX_URL = "https://<your-time-tracker>/api/agent/asks"
$env:T3CODE_USER_REQUEST_INBOX_TOKEN_FILE = "$HOME/.t3-user-request-inbox-token"
$env:T3CODE_USER_REQUEST_LINK_ORIGIN = "https://<host-your-phone-can-reach>"
```
