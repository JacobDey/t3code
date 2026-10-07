import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Inbox from "./UserRequestInbox.ts";

const TOKEN = `tt_${"k".repeat(43)}`;
const INBOX_URL = "https://inbox.example/api/agent/asks";

const layerStubs = Layer.mergeAll(
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed({
        projectId: ProjectId.make("project-1"),
        title: "Release prep",
        providerInstanceId: "codex",
        modelSelection: { model: "gpt-5" },
        branch: "feat/release",
        worktreePath: "/work/release",
      } as never),
  }),
  Layer.mock(ProjectService.ProjectService)({
    getShell: () => Effect.succeedSome({ title: "Shop", workspaceRoot: "/work/shop" } as never),
  }),
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getDescriptor: Effect.succeed({ label: "PC", serverVersion: "0.0.46" } as never),
  }),
);

const createInput = {
  threadId: "thread 1",
  environmentId: "env-1",
  providerSessionId: "session-1",
  providerInstanceId: "codex",
  requestNamespace: "namespace-1",
  request: {
    kind: "calendar" as const,
    title: "Pair on the release",
    when: { start: "2026-10-08T14:00" },
    clientRequestId: "release-pairing",
  },
};

type Answer = Response | "network-error";
/** "hang" never answers; `delay` answers only after that much (test clock) time. */
type Reply = Answer | "hang" | { readonly delay: Duration.Input; readonly then: Answer };

interface Captured {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The `redirect` mode a real fetch client would apply to this request. */
  readonly redirect: globalThis.RequestInit["redirect"];
  /** Test-clock time the request went out. */
  readonly at: number;
}

/** Runs `use` against the real service with a scripted inbox; the last reply repeats. */
const withInbox = <A, E>(
  env: Record<string, string>,
  replies: ReadonlyArray<() => Reply>,
  use: (inbox: Inbox.UserRequestInbox["Service"]) => Effect.Effect<A, E>,
) => {
  const captured: Array<Captured> = [];
  const http = HttpClient.make(
    (request: HttpClientRequest.HttpClientRequest, _url, _signal, fiber) => {
      captured.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
        at: fiber.getRef(Clock.Clock).currentTimeMillisUnsafe(),
      });
      const answer = (reply: Answer) =>
        reply === "network-error"
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request }),
              }),
            )
          : Effect.succeed(HttpClientResponse.fromWeb(request, reply));
      const reply = (replies[captured.length - 1] ?? replies[replies.length - 1])!();
      if (reply === "hang") return Effect.never;
      if (typeof reply === "object" && "delay" in reply) {
        return Effect.sleep(reply.delay).pipe(Effect.andThen(answer(reply.then)));
      }
      return answer(reply);
    },
  );
  return Effect.gen(function* () {
    const inbox = yield* Inbox.UserRequestInbox;
    const result = yield* use(inbox);
    return { result, captured };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Inbox.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerStubs,
              NodeServices.layer,
              Layer.succeed(HttpClient.HttpClient, http),
            ),
          ),
        ),
        // Config is read per call, so the provider must reach the caller, not only the layer.
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );
};

const makeTokenFile = (contents: string, mode = 0o600) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-user-request-inbox-" });
    const tokenFile = `${directory}/inbox-token`;
    yield* fs.writeFileString(tokenFile, contents);
    yield* fs.chmod(tokenFile, mode);
    return tokenFile;
  });

const configured = (tokenFile: string, extra: Record<string, string> = {}) => ({
  T3CODE_USER_REQUEST_INBOX_URL: INBOX_URL,
  T3CODE_USER_REQUEST_INBOX_TOKEN_FILE: tokenFile,
  ...extra,
});

const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    Response.json(body, { status, headers });

const agentView = (overrides: Record<string, unknown> = {}) => ({
  id: "0123456789",
  kind: "calendar",
  title: "Pair on the release",
  status: "pending",
  decided: false,
  outcomePending: false,
  done: null,
  summary: "Waiting for Jacob (filed 1m ago; not opened yet).",
  url: "https://tracker.example/?ask=0123456789",
  pollAfterSeconds: 120,
  ...overrides,
});

/**
 * Runs `effect` while stepping the test clock a second at a time until it finishes. Each step
 * also yields a real macrotask so the token-file read and response bodies (real I/O) keep up.
 */
const onTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* effect.pipe(Effect.forkChild);
    for (let second = 0; second < 900 && fiber.pollUnsafe() === undefined; second++) {
      yield* TestClock.adjust("1 second");
      yield* Effect.sleep("1 millis").pipe(TestClock.withLive);
    }
    return yield* Fiber.join(fiber);
  });

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.orElseSucceed(() => {
      throw new Error("expected the effect to fail");
    }),
  );

it.layer(NodeServices.layer)("UserRequestInbox", (it) => {
  it.effect("reports what is missing without making a request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const malformed = yield* makeTokenFile("too-short");
        const cases = [
          { env: {}, missing: "url" },
          { env: { T3CODE_USER_REQUEST_INBOX_URL: INBOX_URL }, missing: "token-file" },
          { env: configured(`${malformed}.absent`), missing: "token-file" },
          { env: configured(malformed), missing: "token-format" },
        ] as const;
        for (const testCase of cases) {
          const { result, captured } = yield* withInbox(
            testCase.env,
            [json(agentView())],
            (inbox) => failureOf(inbox.read({ requestId: "0123456789", waitSeconds: 0 })),
          );
          expect(result._tag).toBe("UserRequestInboxNotConfiguredError");
          expect(result).toMatchObject({ missing: testCase.missing });
          expect(captured).toEqual([]);
        }
      }),
    ),
  );

  it.effect("refuses a plain-http inbox that is not loopback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tokenFile = yield* makeTokenFile(TOKEN);
        const { result, captured } = yield* withInbox(
          configured(tokenFile, { T3CODE_USER_REQUEST_INBOX_URL: "http://inbox.example/asks" }),
          [json(agentView(), 201)],
          (inbox) => failureOf(inbox.create(createInput)),
        );
        expect(result).toMatchObject({
          _tag: "UserRequestInboxUnsafeConfigError",
          problem: "insecure-url",
        });
        expect(captured).toEqual([]);
      }),
    ),
  );

  // Windows reports synthetic modes, so only a POSIX host can prove the check.
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "refuses a token file that group or other can read",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tokenFile = yield* makeTokenFile(TOKEN, 0o640);
          const { result, captured } = yield* withInbox(
            configured(tokenFile),
            [json(agentView(), 201)],
            (inbox) => failureOf(inbox.create(createInput)),
          );
          expect(result).toMatchObject({
            _tag: "UserRequestInboxUnsafeConfigError",
            problem: "token-file-permissions",
          });
          expect(captured).toEqual([]);
        }),
      ),
  );

  it.effect("posts the request with bearer auth, a namespaced key and thread provenance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tokenFile = yield* makeTokenFile(`  ${TOKEN}\n`);
        const { result, captured } = yield* withInbox(
          configured(tokenFile, { T3CODE_USER_REQUEST_LINK_ORIGIN: "https://t3.example/" }),
          [json(agentView({ created: true }), 201)],
          (inbox) =>
            Effect.all([
              inbox.create(createInput),
              inbox.create({ ...createInput, requestNamespace: "namespace-2" }),
            ]),
        );
        const [first, second] = captured;
        expect(first?.method).toBe("POST");
        expect(first?.url).toBe(INBOX_URL);
        expect(first?.headers.authorization).toBe(`Bearer ${TOKEN}`);
        const key = first?.headers["idempotency-key"];
        expect(key).toMatch(/^t3:[0-9a-f]{40}$/);
        // The agent's key is namespaced, so another namespace never collides with it.
        expect(second?.headers["idempotency-key"]).not.toBe(key);

        const body = JSON.parse(first?.body ?? "{}");
        expect(body).toMatchObject({
          protocol: "user-request-inbox/1",
          clientRequestId: key,
          kind: "calendar",
          title: "Pair on the release",
          when: { start: "2026-10-08T14:00", durationMin: 50 },
          provenance: {
            via: "t3-tool",
            app: "t3code",
            appVersion: "0.0.46",
            agent: "codex",
            model: "gpt-5",
            machine: "PC",
            cwd: "/work/release",
            branch: "feat/release",
            sessionId: "session-1",
            t3: {
              environmentId: "env-1",
              threadId: "thread 1",
              threadTitle: "Release prep",
              projectTitle: "Shop",
              workspaceRoot: "/work/shop",
              path: "/env-1/thread%201",
              link: "https://t3.example/env-1/thread%201",
              match: "tool",
            },
          },
        });
        expect(typeof body.when.timeZone).toBe("string");
        expect(body).not.toHaveProperty("clientRequestId", "release-pairing");
        expect(first?.body).not.toContain(tokenFile);

        expect(result[0]).toEqual({
          id: "0123456789",
          status: "pending",
          created: true,
          url: "https://tracker.example/?ask=0123456789",
          summary: "Waiting for Jacob (filed 1m ago; not opened yet).",
          threadPath: "/env-1/thread%201",
        });
      }),
    ),
  );

  it.effect("derives a stable key from the content when the agent gives none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tokenFile = yield* makeTokenFile(TOKEN);
        const request = { kind: "reply" as const, title: "Which region?", body: "EU or US" };
        const { captured } = yield* withInbox(
          configured(tokenFile),
          [json(agentView({ created: false }))],
          (inbox) =>
            Effect.all([
              inbox.create({ ...createInput, request }),
              inbox.create({
                ...createInput,
                request: { body: "EU or US", title: "Which region?", kind: "reply" },
              }),
              inbox.create({ ...createInput, request: { ...request, title: "Which zone?" } }),
            ]),
        );
        const keys = captured.map((entry) => entry.headers["idempotency-key"]);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[2]).not.toBe(keys[0]);
      }),
    ),
  );

  it.effect("retries a network failure once with the same key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tokenFile = yield* makeTokenFile(TOKEN);
        const { result, captured } = yield* withInbox(
          configured(tokenFile),
          [() => "network-error", json(agentView({ created: true }), 201)],
          (inbox) => inbox.create(createInput),
        );
        expect(result.created).toBe(true);
        expect(captured).toHaveLength(2);
        expect(captured[0]?.headers["idempotency-key"]).toBe(
          captured[1]?.headers["idempotency-key"],
        );

        const failed = yield* withInbox(configured(tokenFile), [() => "network-error"], (inbox) =>
          failureOf(inbox.create(createInput)),
        );
        expect(failed.result).toMatchObject({
          _tag: "UserRequestInboxUnavailableError",
          reason: "network",
        });
        expect(failed.captured).toHaveLength(2);
      }),
    ),
  );

  it.effect("maps inbox responses to typed failures without following redirects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tokenFile = yield* makeTokenFile(TOKEN);
        const cases = [
          {
            reply: () =>
              new Response(null, { status: 308, headers: { location: "https://evil.example/" } }),
            expected: { _tag: "UserRequestInboxUnavailableError", reason: "redirect" },
          },
          {
            reply: json({ error: "bad-request", issues: [{ path: "when.start" }] }, 400),
            expected: { _tag: "UserRequestInboxRejectedError", status: 400, code: "bad-request" },
          },
          {
            reply: json({ error: "not-found" }, 404),
            expected: { _tag: "UserRequestInboxRejectedError", status: 404, code: "not-found" },
          },
          {
            reply: json({ error: "key-reused", id: "0123456789" }, 409),
            expected: { _tag: "UserRequestInboxRejectedError", code: "key-reused" },
          },
          {
            reply: json({ error: "Not A Code <b>" }, 401),
            expected: { _tag: "UserRequestInboxRejectedError", code: "rejected" },
          },
          {
            reply: json({ error: "rate-limited", retryAfterSec: 120 }, 429),
            expected: { _tag: "UserRequestInboxBusyError", retryAfterSeconds: 120 },
          },
          {
            reply: () =>
              new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
            expected: { _tag: "UserRequestInboxBusyError", retryAfterSeconds: 7 },
          },
          {
            reply: json({ error: "agent-api-off" }, 503),
            expected: { _tag: "UserRequestInboxRejectedError", status: 503, code: "agent-api-off" },
          },
          {
            reply: () => new Response("<html>bad gateway</html>", { status: 502 }),
            expected: { _tag: "UserRequestInboxUnavailableError", reason: "server" },
          },
          {
            reply: () => new Response("not json", { status: 201 }),
            expected: { _tag: "UserRequestInboxUnavailableError", reason: "bad-response" },
          },
          {
            reply: json({ ...agentView(), padding: "x".repeat(70_000) }, 201),
            expected: { _tag: "UserRequestInboxUnavailableError", reason: "bad-response" },
          },
        ];
        for (const testCase of cases) {
          const { result, captured } = yield* withInbox(
            configured(tokenFile),
            [testCase.reply],
            (inbox) => failureOf(inbox.create(createInput)),
          );
          expect(result).toMatchObject(testCase.expected);
          expect(captured).toHaveLength(1);
          // A real fetch client must hand the 3xx back instead of resending the bearer token.
          expect(captured[0]?.redirect).toBe("manual");
        }
      }),
    ),
  );

  it.effect("clamps an absurd retry-after instead of failing as a defect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tokenFile = yield* makeTokenFile(TOKEN);
        const cases = [
          json({ error: "rate-limited", retryAfterSec: 1e20 }, 429),
          () =>
            new Response("slow down", {
              status: 429,
              headers: { "retry-after": "99999999999999999999" },
            }),
        ];
        for (const reply of cases) {
          const { result } = yield* withInbox(configured(tokenFile), [reply], (inbox) =>
            failureOf(inbox.create(createInput)),
          );
          expect(result).toMatchObject({
            _tag: "UserRequestInboxBusyError",
            retryAfterSeconds: 86_400,
          });
        }
      }),
    ),
  );

  it.effect("gives up on an inbox that never answers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tokenFile = yield* makeTokenFile(TOKEN);
        const { result, captured } = yield* withInbox(
          configured(tokenFile),
          [() => "hang" as const],
          (inbox) => onTestClock(failureOf(inbox.create(createInput))),
        );
        expect(result).toMatchObject({
          _tag: "UserRequestInboxUnavailableError",
          reason: "timeout",
        });
        // A timeout is not retried: the inbox may still be working on the first attempt.
        expect(captured).toHaveLength(1);
      }),
    ),
  );

  it.effect("reads one request and reports a missing one as not found", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tokenFile = yield* makeTokenFile(TOKEN);
        const approved = agentView({
          status: "edited",
          decided: true,
          note: "Make it shorter",
          decidedAt: "2026-10-07T10:00:00.000Z",
          reopenedAt: null,
          final: {
            title: "Pair on the release",
            when: {
              start: "2026-10-08T15:00",
              end: "2026-10-08T16:00",
              durationMin: 60,
              timeZone: "America/New_York",
            },
            pomodoros: 2,
            destinations: ["pomodoro", "google"],
          },
          pollAfterSeconds: 0,
          url: "javascript:alert(1)",
          extra: { ignored: true },
        });
        const { result, captured } = yield* withInbox(
          configured(tokenFile),
          [json(approved)],
          (inbox) => inbox.read({ requestId: "0123456789", waitSeconds: 0 }),
        );
        expect(captured[0]).toMatchObject({ method: "GET", url: `${INBOX_URL}/0123456789` });
        expect(captured[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(result).toMatchObject({
          id: "0123456789",
          status: "edited",
          decided: true,
          done: null,
          note: "Make it shorter",
          url: null,
          final: {
            title: "Pair on the release",
            start: "2026-10-08T15:00",
            end: "2026-10-08T16:00",
            durationMin: 60,
            date: null,
            timeZone: "America/New_York",
            pomodoros: 2,
            destinations: ["pomodoro", "google"],
          },
        });

        const missing = yield* withInbox(
          configured(tokenFile),
          [json({ error: "not-found" }, 404)],
          (inbox) => failureOf(inbox.read({ requestId: "zzzzzzzzzz", waitSeconds: 0 })),
        );
        expect(missing.result).toBeInstanceOf(Inbox.UserRequestNotFoundError);
        expect(missing.result).toMatchObject({ requestId: "zzzzzzzzzz" });
      }),
    ),
  );

  it.effect("waits until the request settles, including while its outcome is pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tokenFile = yield* makeTokenFile(TOKEN);
        const flips = yield* withInbox(
          configured(tokenFile),
          [
            json(agentView()),
            json(agentView()),
            json(agentView({ status: "answered", decided: true, answer: "EU" })),
          ],
          (inbox) => onTestClock(inbox.read({ requestId: "0123456789", waitSeconds: 60 })),
        );
        expect(flips.result).toMatchObject({ status: "answered", answer: "EU" });
        expect(flips.captured).toHaveLength(3);

        const settling = yield* withInbox(
          configured(tokenFile),
          [
            json(agentView({ status: "approved", decided: true, outcomePending: true })),
            json(agentView({ status: "approved", decided: true, outcomePending: true })),
            json(agentView({ status: "approved", decided: true, done: false })),
          ],
          (inbox) => onTestClock(inbox.read({ requestId: "0123456789", waitSeconds: 60 })),
        );
        expect(settling.result).toMatchObject({
          status: "approved",
          outcomePending: false,
          done: false,
        });
        expect(settling.captured).toHaveLength(3);

        const budget = yield* withInbox(configured(tokenFile), [json(agentView())], (inbox) =>
          onTestClock(inbox.read({ requestId: "0123456789", waitSeconds: 14 })),
        );
        expect(budget.result.status).toBe("pending");
        // Polls at 0, 5 and 10 seconds, then once more when the 14 second budget runs out.
        expect(budget.captured).toHaveLength(4);

        // A slow, failing final poll and its retry still finish by waitSeconds + 10 seconds.
        const pending = json(agentView());
        const overrun = yield* withInbox(
          configured(tokenFile),
          [
            pending,
            pending,
            pending,
            () => ({ delay: "9 seconds", then: "network-error" }),
            () => "hang",
          ],
          (inbox) =>
            onTestClock(
              failureOf(inbox.read({ requestId: "0123456789", waitSeconds: 14 })).pipe(
                Effect.andThen((error) =>
                  Effect.map(Clock.currentTimeMillis, (at) => ({ error, at })),
                ),
              ),
            ),
        );
        expect(overrun.result.error).toMatchObject({
          _tag: "UserRequestInboxUnavailableError",
          reason: "timeout",
        });
        // Polls at 0, 5, 10 and 14 seconds; the last fails at 23 and its retry gets the one
        // second left. Unbounded, that retry would hang until 33 seconds.
        const startedAt = overrun.captured[0]?.at ?? 0;
        expect(overrun.captured.map((entry) => entry.at - startedAt)).toEqual([
          0, 5_000, 10_000, 14_000, 23_000,
        ]);
        expect(overrun.result.at - startedAt).toBe(24_000);
      }),
    ),
  );

  it.effect("never puts the token, its path or the inbox URL in an error message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tokenFile = yield* makeTokenFile(TOKEN);
        const malformed = yield* makeTokenFile("bad token with spaces");
        const runs = [
          withInbox({}, [json(agentView())], (inbox) => failureOf(inbox.create(createInput))),
          withInbox(configured(malformed), [json(agentView())], (inbox) =>
            failureOf(inbox.create(createInput)),
          ),
          withInbox(configured(`${tokenFile}.absent`), [json(agentView())], (inbox) =>
            failureOf(inbox.create(createInput)),
          ),
          withInbox(
            configured(tokenFile, { T3CODE_USER_REQUEST_INBOX_URL: "http://inbox.example/x" }),
            [json(agentView())],
            (inbox) => failureOf(inbox.create(createInput)),
          ),
          ...[
            json({ error: "bad-request", echo: TOKEN }, 400),
            json({ error: "rate-limited" }, 429),
            () => new Response(`${TOKEN} ${tokenFile}`, { status: 500 }),
            () => new Response(null, { status: 302, headers: { location: INBOX_URL } }),
            () => "network-error" as const,
          ].map((reply) =>
            withInbox(configured(tokenFile), [reply], (inbox) =>
              failureOf(inbox.create(createInput)),
            ),
          ),
          withInbox(configured(tokenFile), [json({ error: "not-found" }, 404)], (inbox) =>
            failureOf(inbox.read({ requestId: "0123456789", waitSeconds: 0 })),
          ),
        ];
        const tags = new Set<string>();
        for (const run of runs) {
          const { result } = yield* run;
          tags.add(result._tag);
          for (const secret of [TOKEN, tokenFile, malformed, "inbox.example"]) {
            expect(result.message).not.toContain(secret);
          }
        }
        expect([...tags].toSorted()).toEqual([
          "UserRequestInboxBusyError",
          "UserRequestInboxNotConfiguredError",
          "UserRequestInboxRejectedError",
          "UserRequestInboxUnavailableError",
          "UserRequestInboxUnsafeConfigError",
          "UserRequestNotFoundError",
        ]);
      }),
    ),
  );
});
