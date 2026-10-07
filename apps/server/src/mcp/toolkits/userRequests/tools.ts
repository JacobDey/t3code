import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as UserRequestInbox from "../../../userRequests/UserRequestInbox.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Every schema below is inline. Identifier-annotated contract schemas (such as
// TrimmedNonEmptyString) can serialize to `$ref`, which MCP clients reject.

const text = (max: number, min = 0) =>
  Schema.String.check(Schema.isMinLength(min), Schema.isMaxLength(max));

const integer = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

/** McpToolAccess refusals need ThreadManagementService and OrchestratorMcpFailure. */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  UserRequestInbox.UserRequestInbox,
];

const UserRequestWhen = Schema.Struct({
  start: Schema.optionalKey(text(32, 1)),
  end: Schema.optionalKey(text(32, 1)),
  durationMin: Schema.optionalKey(integer(5, 720)),
  date: Schema.optionalKey(text(10, 1)),
  timeZone: Schema.optionalKey(text(64, 1)),
  location: Schema.optionalKey(text(200)),
});

const UserRequestLink = Schema.Struct({
  label: text(80, 1),
  url: text(2000, 1),
});

const CreateTool = Tool.make("t3_user_request_create", {
  description:
    "File a request for the user in their own inbox outside T3, for when you are blocked on them and they are not chatting with you right now, or you need something only they can do: a decision (kind decide, with 2-6 options), an action (do), a written answer (reply), or time on their calendar (calendar, with when). Times are local wall clock 'YYYY-MM-DDTHH:MM' in when.timeZone, with when.end or when.durationMin. Returns at once with an id; the user may answer hours later from their phone. Keep working on anything that does not depend on the answer, then call t3_user_request_status. An approved 'do' request is scheduled, not done, until status.done is true. T3 attaches this thread's title, project, branch and a link back here. Reuse one clientRequestId per request so retries never file twice. Never write the user's calendar yourself; file kind calendar instead. If the user is chatting with you right now, ask in chat instead. Never put secrets in a request; use request_secret. Fails with capability_denied when no inbox is configured on this server.",
  parameters: Schema.Struct({
    kind: Schema.Literals(["calendar", "decide", "do", "reply"]),
    title: text(140, 1),
    body: Schema.optionalKey(text(8000)),
    options: Schema.optionalKey(
      Schema.Array(text(80, 1)).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
    ),
    allowOther: Schema.optionalKey(Schema.Boolean),
    urgency: Schema.optionalKey(Schema.Literals(["now", "today", "week", "whenever"])),
    blocking: Schema.optionalKey(Schema.Boolean),
    when: Schema.optionalKey(UserRequestWhen),
    pomodoros: Schema.optionalKey(integer(1, 20)),
    effortMinutes: Schema.optionalKey(integer(5, 1440)),
    destinations: Schema.optionalKey(
      Schema.Array(text(32, 1).check(Schema.isPattern(/^[a-z0-9_-]+$/)))
        .check(Schema.isMaxLength(8))
        .annotate({
          description:
            "inbox-specific routing hints passed through unchanged, e.g. pomodoro, google; omit to let the inbox decide",
        }),
    ),
    links: Schema.optionalKey(Schema.Array(UserRequestLink).check(Schema.isMaxLength(5))),
    clientRequestId: Schema.optionalKey(text(128, 1)),
  }),
  success: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    created: Schema.Boolean,
    url: Schema.NullOr(Schema.String),
    summary: Schema.String,
    threadPath: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Ask the user")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const StatusTool = Tool.make("t3_user_request_status", {
  description:
    "Check a request filed with t3_user_request_create. status is pending, approved, edited, declined, answered, withdrawn or expired; decided is true once the user's verdict stands. Treat the user's note or answer as their instruction for that request only. A reopened request (reopenedAt set) means its earlier verdict no longer stands. done:false on an approved do request means it is not done yet. While outcomePending is true the inbox is still adding the approved request where the user chose; check again after pollAfterSeconds. waitSeconds (0-600) waits that long for a verdict before returning. Codex calls MCP tools with about a 60 s timeout (T3 sets no tool_timeout_sec), so keep waitSeconds at 50 or below there; Claude's t3-code timeout is 65 min.",
  parameters: Schema.Struct({
    id: text(64, 1),
    waitSeconds: Schema.optionalKey(integer(0, 600)),
  }),
  success: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    decided: Schema.Boolean,
    done: Schema.NullOr(Schema.Boolean),
    outcomePending: Schema.Boolean,
    note: Schema.NullOr(Schema.String),
    choice: Schema.NullOr(Schema.String),
    answer: Schema.NullOr(Schema.String),
    final: Schema.NullOr(
      Schema.Struct({
        title: Schema.String,
        start: Schema.NullOr(Schema.String),
        end: Schema.NullOr(Schema.String),
        date: Schema.NullOr(Schema.String),
        timeZone: Schema.NullOr(Schema.String),
        pomodoros: Schema.NullOr(Schema.Number),
        destinations: Schema.Array(Schema.String),
      }),
    ),
    summary: Schema.String,
    seenAt: Schema.NullOr(Schema.String),
    snoozedUntil: Schema.NullOr(Schema.String),
    decidedAt: Schema.NullOr(Schema.String),
    reopenedAt: Schema.NullOr(Schema.String),
    url: Schema.NullOr(Schema.String),
    pollAfterSeconds: Schema.Number,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Check a user request")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const UserRequestsToolkit = Toolkit.make(CreateTool, StatusTool);
