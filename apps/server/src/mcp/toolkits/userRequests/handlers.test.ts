import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as UserRequestInbox from "../../../userRequests/UserRequestInbox.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as UserRequestsHandlers from "./handlers.ts";
import { UserRequestsToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("user-request-thread");

const threadScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("user-request-environment"),
  requestNamespace: "user-request-namespace",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "user-request-provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 0,
};

const clientScope: McpInvocationContext.McpInvocationScope = {
  ...threadScope,
  thread: undefined,
  client: { sessionId: "oauth-session", label: "Outside client", access: "full-access" },
};

const created: UserRequestInbox.UserRequestCreated = {
  id: "0123456789",
  status: "pending",
  created: true,
  url: "https://inbox.example/?ask=0123456789",
  summary: "Waiting for the user (filed 0m ago; not opened yet).",
  threadPath: "/user-request-environment/user-request-thread",
};

const status: UserRequestInbox.UserRequestStatus = {
  id: "0123456789",
  status: "approved",
  decided: true,
  done: null,
  outcomePending: false,
  note: "Fine by me",
  choice: null,
  answer: null,
  final: {
    title: "Review the plan",
    start: "2026-10-08T14:00",
    end: "2026-10-08T15:00",
    durationMin: null,
    date: null,
    timeZone: "America/New_York",
    pomodoros: 2,
    destinations: ["pomodoro"],
  },
  summary: "Approved: added to Time Tracker (2 pomodoros).",
  seenAt: "2026-10-07T12:00:00.000Z",
  snoozedUntil: null,
  decidedAt: "2026-10-07T12:05:00.000Z",
  reopenedAt: null,
  url: "https://inbox.example/?ask=0123456789",
  pollAfterSeconds: 0,
};

type CreateInput = Parameters<UserRequestInbox.UserRequestInbox["Service"]["create"]>[0];
type ReadInput = Parameters<UserRequestInbox.UserRequestInbox["Service"]["read"]>[0];

interface HarnessOptions {
  readonly scope?: McpInvocationContext.McpInvocationScope;
  readonly threads?: Layer.Layer<ThreadManagementService.ThreadManagementService>;
  readonly failure?: UserRequestInbox.UserRequestInboxError;
}

const makeHarness = Effect.fn("makeUserRequestsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const creates = yield* Ref.make<ReadonlyArray<CreateInput>>([]);
  const reads = yield* Ref.make<ReadonlyArray<ReadInput>>([]);
  const layerDependencies = Layer.mergeAll(
    Layer.mock(UserRequestInbox.UserRequestInbox)({
      create: (input) =>
        Ref.update(creates, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(
            options.failure === undefined ? Effect.succeed(created) : Effect.fail(options.failure),
          ),
        ),
      read: (input) =>
        Ref.update(reads, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(
            options.failure === undefined ? Effect.succeed(status) : Effect.fail(options.failure),
          ),
        ),
    }),
    options.threads ?? McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* UserRequestsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(UserRequestsHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof UserRequestsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        options.scope ?? threadScope,
      ),
      Effect.provide(layerDependencies),
    );
  return { creates, reads, call };
});

const createParams = {
  kind: "decide",
  title: "Which database?",
  body: "Both work; Postgres costs more.",
  options: ["Postgres", "SQLite"],
  urgency: "today",
  clientRequestId: "pick-database",
} as const;

describe("user request toolkit handlers", () => {
  it.effect("files a request with the calling thread's scope as plain fields", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("t3_user_request_create", createParams);
      expect(result.isFailure).toBe(false);
      expect(result.result).toEqual(created);
      expect(yield* Ref.get(harness.creates)).toEqual([
        {
          threadId: THREAD_ID,
          environmentId: "user-request-environment",
          providerSessionId: "user-request-provider-session",
          providerInstanceId: "codex",
          requestNamespace: "user-request-namespace",
          request: createParams,
        },
      ]);
    }),
  );

  it.effect("refuses a client signed in from outside a thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ scope: clientScope });
      for (const result of [
        yield* harness.call("t3_user_request_create", createParams),
        yield* harness.call("t3_user_request_status", { id: "0123456789" }),
      ]) {
        expect(result.isFailure).toBe(true);
        expect(result.result).toMatchObject({
          _tag: "OrchestratorMcpFailure",
          code: "thread_credential_required",
        });
      }
      expect(yield* Ref.get(harness.creates)).toEqual([]);
      expect(yield* Ref.get(harness.reads)).toEqual([]);
    }),
  );

  it.effect("refuses to file from a thread whose run has ended", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(McpToolAccessTestkit.liveThreadShell(threadId, { activeRunId: null })),
        }),
      });
      const result = yield* harness.call("t3_user_request_create", createParams);
      expect(result.isFailure).toBe(true);
      expect(result.result).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "parent_not_active",
      });
      expect(yield* Ref.get(harness.creates)).toEqual([]);
    }),
  );

  it.effect.each([
    {
      error: new UserRequestInbox.UserRequestInboxNotConfiguredError({ missing: "url" }),
      code: "capability_denied",
    },
    {
      error: new UserRequestInbox.UserRequestInboxUnsafeConfigError({ problem: "insecure-url" }),
      code: "capability_denied",
    },
    {
      error: new UserRequestInbox.UserRequestNotFoundError({ requestId: "0123456789" }),
      code: "invalid_request",
    },
    {
      error: new UserRequestInbox.UserRequestInboxRejectedError({
        operation: "create",
        status: 409,
        code: "key-reused",
      }),
      code: "invalid_request",
    },
    {
      error: new UserRequestInbox.UserRequestInboxBusyError({ retryAfterSeconds: 60 }),
      code: "orchestration_error",
    },
    {
      error: new UserRequestInbox.UserRequestInboxUnavailableError({
        operation: "read",
        reason: "timeout",
      }),
      code: "orchestration_error",
    },
  ])("maps $error._tag to $code", ({ error, code }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ failure: error });
      for (const result of [
        yield* harness.call("t3_user_request_create", createParams),
        yield* harness.call("t3_user_request_status", { id: "0123456789" }),
      ]) {
        expect(result.isFailure).toBe(true);
        expect(result.result).toEqual(
          expect.objectContaining({
            _tag: "OrchestratorMcpFailure",
            code,
            message: error.message,
          }),
        );
      }
    }),
  );

  it.effect("passes status through and defaults waitSeconds to 0", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const immediate = yield* harness.call("t3_user_request_status", { id: "0123456789" });
      const waited = yield* harness.call("t3_user_request_status", {
        id: "0123456789",
        waitSeconds: 45,
      });
      for (const result of [immediate, waited]) {
        expect(result.isFailure).toBe(false);
        expect(result.result).toEqual(status);
      }
      expect(yield* Ref.get(harness.reads)).toEqual([
        { requestId: "0123456789", waitSeconds: 0 },
        { requestId: "0123456789", waitSeconds: 45 },
      ]);
    }),
  );
});
