import { ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

export class UserRequestInboxNotConfiguredError extends Schema.TaggedError<UserRequestInboxNotConfiguredError>()(
  "UserRequestInboxNotConfiguredError",
  { missing: Schema.Literals(["url", "token-file", "token-format"]) },
) {
  override get message(): string {
    return "No user request inbox is configured on this T3 server (set T3CODE_USER_REQUEST_INBOX_URL and T3CODE_USER_REQUEST_INBOX_TOKEN_FILE).";
  }
}

export class UserRequestInboxUnsafeConfigError extends Schema.TaggedError<UserRequestInboxUnsafeConfigError>()(
  "UserRequestInboxUnsafeConfigError",
  { problem: Schema.Literals(["insecure-url", "token-file-permissions"]) },
) {
  override get message(): string {
    return "The user request inbox is configured unsafely: the URL must use https (http only for loopback) and the token file must be readable only by you.";
  }
}

export class UserRequestInboxRejectedError extends Schema.TaggedError<UserRequestInboxRejectedError>()(
  "UserRequestInboxRejectedError",
  { operation: Schema.Literals(["create", "read"]), status: Schema.Int, code: Schema.String },
) {
  override get message(): string {
    return `The inbox refused the request (HTTP ${this.status}: ${this.code}).`;
  }
}

export class UserRequestNotFoundError extends Schema.TaggedError<UserRequestNotFoundError>()(
  "UserRequestNotFoundError",
  { requestId: Schema.String },
) {
  override get message(): string {
    return "No request with that id.";
  }
}

export class UserRequestInboxBusyError extends Schema.TaggedError<UserRequestInboxBusyError>()(
  "UserRequestInboxBusyError",
  { retryAfterSeconds: Schema.optional(Schema.Int) },
) {
  override get message(): string {
    return "The user request inbox is busy (rate-limited or full); retry later and do not refile with new wording.";
  }
}

export class UserRequestInboxUnavailableError extends Schema.TaggedError<UserRequestInboxUnavailableError>()(
  "UserRequestInboxUnavailableError",
  {
    operation: Schema.Literals(["create", "read"]),
    reason: Schema.Literals(["timeout", "network", "server", "redirect", "bad-response"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The user request inbox could not be reached (${this.reason}).`;
  }
}

export type UserRequestInboxError =
  | UserRequestInboxNotConfiguredError
  | UserRequestInboxUnsafeConfigError
  | UserRequestInboxRejectedError
  | UserRequestNotFoundError
  | UserRequestInboxBusyError
  | UserRequestInboxUnavailableError;

export interface UserRequestInput {
  readonly kind: "calendar" | "decide" | "do" | "reply";
  readonly title: string;
  readonly body?: string | undefined;
  readonly options?: ReadonlyArray<string> | undefined;
  readonly allowOther?: boolean | undefined;
  readonly urgency?: "now" | "today" | "week" | "whenever" | undefined;
  readonly blocking?: boolean | undefined;
  readonly when?:
    | {
        readonly start?: string | undefined;
        readonly end?: string | undefined;
        readonly durationMin?: number | undefined;
        readonly date?: string | undefined;
        readonly timeZone?: string | undefined;
        readonly location?: string | undefined;
      }
    | undefined;
  readonly pomodoros?: number | undefined;
  readonly effortMinutes?: number | undefined;
  readonly destinations?: ReadonlyArray<string> | undefined;
  readonly links?: ReadonlyArray<{ readonly label: string; readonly url: string }> | undefined;
  readonly clientRequestId?: string | undefined;
}

export interface UserRequestCreated {
  readonly id: string;
  readonly status: string;
  readonly created: boolean;
  readonly url: string | null;
  readonly summary: string;
  readonly threadPath: string;
}

export interface UserRequestStatus {
  readonly id: string;
  readonly status: string;
  readonly decided: boolean;
  readonly done: boolean | null;
  readonly outcomePending: boolean;
  readonly note: string | null;
  readonly choice: string | null;
  readonly answer: string | null;
  readonly final: {
    readonly title: string;
    readonly start: string | null;
    readonly end: string | null;
    readonly date: string | null;
    readonly timeZone: string | null;
    readonly pomodoros: number | null;
    readonly destinations: ReadonlyArray<string>;
  } | null;
  readonly summary: string;
  readonly seenAt: string | null;
  readonly snoozedUntil: string | null;
  readonly decidedAt: string | null;
  readonly reopenedAt: string | null;
  readonly url: string | null;
  readonly pollAfterSeconds: number;
}

export class UserRequestInbox extends Context.Service<
  UserRequestInbox,
  {
    readonly create: (input: {
      readonly threadId: string;
      readonly environmentId: string;
      readonly providerSessionId: string | undefined;
      readonly providerInstanceId: string | undefined;
      readonly requestNamespace: string;
      readonly request: UserRequestInput;
    }) => Effect.Effect<UserRequestCreated, UserRequestInboxError>;
    readonly read: (input: {
      readonly requestId: string;
      readonly waitSeconds: number;
    }) => Effect.Effect<UserRequestStatus, UserRequestInboxError>;
  }
>()("t3/userRequests/UserRequestInbox") {}

const PROTOCOL = "user-request-inbox/1";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_WAIT_SECONDS = 600;
const POLL_INTERVAL = Duration.seconds(5);
const DEFAULT_DURATION_MIN = 50;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const ERROR_CODE_PATTERN = /^[a-z-]{1,40}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Read per call, never at startup, so a missing value cannot break boot. The token itself is
// never an env var: T3 passes its whole environment to every provider process.
const InboxConfig = Config.all({
  url: Config.String("T3CODE_USER_REQUEST_INBOX_URL").pipe(Config.option),
  tokenFile: Config.String("T3CODE_USER_REQUEST_INBOX_TOKEN_FILE").pipe(Config.option),
  linkOrigin: Config.String("T3CODE_USER_REQUEST_LINK_ORIGIN").pipe(Config.option),
});

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Provenance strings: control and bidi characters stripped, trimmed, truncated to the 3.1 bound. */
const bounded = (value: string | null | undefined, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .normalize("NFC")
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point.
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, max) : undefined;
};

/** http(s) only, no userinfo, at most 2000 characters; anything else is dropped. */
const safeHttpUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 2000) return null;
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.href.length <= 2000 ? url.href : null;
};

/** Sorted keys at every level, so the default client key ignores property order. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const toStatus = (body: Record<string, unknown>): UserRequestStatus => {
  const final = asRecord(body.final);
  const when = asRecord(final?.when) ?? {};
  return {
    id: String(body.id),
    status: String(body.status),
    decided: body.decided === true,
    done: typeof body.done === "boolean" ? body.done : null,
    outcomePending: body.outcomePending === true,
    note: stringOrNull(body.note),
    choice: stringOrNull(body.choice),
    answer: stringOrNull(body.answer),
    final: final
      ? {
          title: stringOrNull(final.title) ?? "",
          start: stringOrNull(when.start),
          end: stringOrNull(when.end),
          date: stringOrNull(when.date),
          timeZone: stringOrNull(when.timeZone),
          pomodoros: numberOrNull(final.pomodoros),
          destinations: Array.isArray(final.destinations)
            ? final.destinations.filter((entry): entry is string => typeof entry === "string")
            : [],
        }
      : null,
    summary: stringOrNull(body.summary) ?? "",
    seenAt: stringOrNull(body.seenAt),
    snoozedUntil: stringOrNull(body.snoozedUntil),
    decidedAt: stringOrNull(body.decidedAt),
    reopenedAt: stringOrNull(body.reopenedAt),
    url: safeHttpUrl(body.url),
    pollAfterSeconds: Math.max(0, numberOrNull(body.pollAfterSeconds) ?? 0),
  };
};

interface InboxTarget {
  readonly url: string;
  readonly token: Redacted.Redacted<string>;
  readonly linkOrigin: string | null;
}

const make = Effect.gen(function* () {
  // Captured only; the registration test builds this layer against bare stubs.
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;

  const loadTarget: Effect.Effect<
    InboxTarget,
    UserRequestInboxNotConfiguredError | UserRequestInboxUnsafeConfigError
  > = Effect.gen(function* () {
    const config = yield* InboxConfig.pipe(
      Effect.mapError(() => new UserRequestInboxNotConfiguredError({ missing: "url" })),
    );
    if (Option.isNone(config.url)) {
      return yield* new UserRequestInboxNotConfiguredError({ missing: "url" });
    }
    if (Option.isNone(config.tokenFile)) {
      return yield* new UserRequestInboxNotConfiguredError({ missing: "token-file" });
    }
    const url = safeHttpUrl(config.url.value.trim());
    if (url === null) {
      return yield* new UserRequestInboxUnsafeConfigError({ problem: "insecure-url" });
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
      return yield* new UserRequestInboxUnsafeConfigError({ problem: "insecure-url" });
    }
    const tokenFile = config.tokenFile.value;
    const info = yield* fileSystem
      .stat(tokenFile)
      .pipe(
        Effect.mapError(() => new UserRequestInboxNotConfiguredError({ missing: "token-file" })),
      );
    // Windows reports synthetic POSIX modes, so the group/other check only means something on POSIX.
    if ((yield* HostProcessPlatform) !== "win32" && (info.mode & 0o077) !== 0) {
      return yield* new UserRequestInboxUnsafeConfigError({ problem: "token-file-permissions" });
    }
    const token = (yield* fileSystem
      .readFileString(tokenFile)
      .pipe(
        Effect.mapError(() => new UserRequestInboxNotConfiguredError({ missing: "token-file" })),
      )).trim();
    if (!TOKEN_PATTERN.test(token)) {
      return yield* new UserRequestInboxNotConfiguredError({ missing: "token-format" });
    }
    const linkOrigin = Option.isSome(config.linkOrigin)
      ? safeHttpUrl(config.linkOrigin.value.trim())
      : null;
    return {
      url: url.replace(/\/+$/, ""),
      token: Redacted.make(token),
      linkOrigin: linkOrigin === null ? null : linkOrigin.replace(/\/+$/, ""),
    };
  });

  /** One request with transport policy and status mapping; returns the decoded 2xx body. */
  const send = (input: {
    readonly operation: "create" | "read";
    readonly request: HttpClientRequest.HttpClientRequest;
    readonly requestId?: string;
  }) => {
    const { operation } = input;
    const unavailable = (
      reason: UserRequestInboxUnavailableError["reason"],
      cause?: unknown,
    ): UserRequestInboxUnavailableError =>
      new UserRequestInboxUnavailableError(
        cause === undefined ? { operation, reason } : { operation, reason, cause },
      );

    const attempt = Effect.gen(function* () {
      const response = yield* httpClient.execute(input.request).pipe(
        Effect.mapError((error) =>
          // Keep only the underlying transport failure: the request carries the bearer header.
          unavailable(
            error.reason._tag === "TransportError" ? "network" : "bad-response",
            error.reason.cause,
          ),
        ),
      );
      if (response.status >= 300 && response.status < 400) {
        return { status: response.status, headers: response.headers, text: null };
      }
      let received = 0;
      const chunks = yield* response.stream.pipe(
        Stream.mapEffect((chunk) => {
          received += chunk.byteLength;
          return received > MAX_RESPONSE_BYTES
            ? Effect.fail(unavailable("bad-response"))
            : Effect.succeed(chunk);
        }),
        Stream.runCollect,
        Effect.mapError((error) =>
          error._tag === "UserRequestInboxUnavailableError"
            ? error
            : unavailable("network", error.reason.cause),
        ),
      );
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        status: response.status,
        headers: response.headers,
        text: new TextDecoder().decode(bytes),
      };
    }).pipe(
      Effect.scoped,
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("10 seconds"),
      Effect.catchTags({ TimeoutError: (error) => Effect.fail(unavailable("timeout", error)) }),
    );

    return Effect.gen(function* () {
      // One retry on a network failure; the create carries the same Idempotency-Key both times.
      const response = yield* attempt.pipe(
        Effect.catchTags({
          UserRequestInboxUnavailableError: (error) =>
            error.reason === "network" ? attempt : Effect.fail(error),
        }),
      );
      if (response.text === null) return yield* unavailable("redirect");
      const decoded = yield* decodeJson(response.text).pipe(
        Effect.map(asRecord),
        Effect.orElseSucceed(() => null),
      );
      const status = response.status;
      if (status === 429) {
        const fromBody = numberOrNull(decoded?.retryAfterSec);
        const fromHeader = Number.parseInt(response.headers["retry-after"] ?? "", 10);
        const retryAfter = fromBody ?? (Number.isFinite(fromHeader) ? fromHeader : null);
        return yield* new UserRequestInboxBusyError(
          retryAfter === null ? {} : { retryAfterSeconds: Math.max(0, Math.floor(retryAfter)) },
        );
      }
      if (operation === "read" && status === 404) {
        return yield* new UserRequestNotFoundError({
          requestId: (input.requestId ?? "").slice(0, 64),
        });
      }
      const code =
        typeof decoded?.error === "string" && ERROR_CODE_PATTERN.test(decoded.error)
          ? decoded.error
          : "rejected";
      if (status >= 500 && code !== "agent-api-off") return yield* unavailable("server");
      if (status >= 400) {
        return yield* new UserRequestInboxRejectedError({ operation, status, code });
      }
      if (
        status < 200 ||
        status >= 300 ||
        decoded === null ||
        typeof decoded.id !== "string" ||
        decoded.id.length === 0 ||
        decoded.id.length > 64 ||
        typeof decoded.status !== "string"
      ) {
        return yield* unavailable("bad-response");
      }
      return decoded;
    });
  };

  const create: UserRequestInbox["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const target = yield* loadTarget;
      const { clientRequestId: agentKey, ...content } = input.request;

      const thread = yield* threads.getThreadShell(ThreadId.make(input.threadId)).pipe(
        Effect.option,
        Effect.map((shell) => Option.getOrNull(shell) ?? null),
      );
      const project =
        thread === null
          ? null
          : yield* projects.getShell(thread.projectId).pipe(
              Effect.option,
              Effect.map((shell) => Option.getOrNull(Option.flatten(shell))),
            );
      const descriptor = yield* serverEnvironment.getDescriptor.pipe(
        Effect.option,
        Effect.map(Option.getOrNull),
      );

      const threadPath = `/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
      const link = target.linkOrigin === null ? null : safeHttpUrl(target.linkOrigin + threadPath);
      const provenance = {
        via: "t3-tool",
        app: "t3code",
        appVersion: bounded(descriptor?.serverVersion, 40),
        agent: bounded(input.providerInstanceId ?? thread?.providerInstanceId, 40) ?? "other",
        model: bounded(thread?.modelSelection.model, 80),
        machine: bounded(descriptor?.label, 40),
        cwd: bounded(thread?.worktreePath ?? project?.workspaceRoot, 400),
        branch: bounded(thread?.branch, 200),
        sessionId: bounded(input.providerSessionId, 128),
        t3: {
          environmentId: bounded(input.environmentId, 64),
          threadId: input.threadId.slice(0, 256),
          threadTitle: bounded(thread?.title, 300),
          projectTitle: bounded(project?.title, 200),
          workspaceRoot: bounded(project?.workspaceRoot, 400),
          path: threadPath,
          ...(link === null ? {} : { link }),
          match: "tool",
        },
      };

      const when =
        content.when?.start === undefined
          ? content.when
          : {
              ...content.when,
              timeZone: content.when.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
              ...(content.when.end === undefined && content.when.durationMin === undefined
                ? { durationMin: DEFAULT_DURATION_MIN }
                : {}),
            };

      const encodingFailed = (cause: unknown) =>
        new UserRequestInboxUnavailableError({
          operation: "create",
          reason: "bad-response",
          cause,
        });
      const keySource =
        agentKey ?? (yield* encodeJson(canonical(content)).pipe(Effect.mapError(encodingFailed)));
      const digest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(`${input.requestNamespace}\n${keySource}`))
        .pipe(Effect.mapError(encodingFailed));
      const clientRequestId = `t3:${Hex.encode(digest).slice(0, 40)}`;

      const request = yield* HttpClientRequest.post(target.url).pipe(
        HttpClientRequest.bearerToken(Redacted.value(target.token)),
        HttpClientRequest.setHeader("Idempotency-Key", clientRequestId),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          protocol: PROTOCOL,
          ...content,
          when,
          clientRequestId,
          provenance,
        }),
        Effect.mapError(encodingFailed),
      );
      const body = yield* send({ operation: "create", request });
      return {
        id: String(body.id),
        status: String(body.status),
        created: body.created === true,
        url: safeHttpUrl(body.url),
        summary: stringOrNull(body.summary) ?? "",
        threadPath,
      };
    });

  const read: UserRequestInbox["Service"]["read"] = (input) =>
    Effect.gen(function* () {
      const target = yield* loadTarget;
      const request = HttpClientRequest.get(
        `${target.url}/${encodeURIComponent(input.requestId)}`,
      ).pipe(
        HttpClientRequest.bearerToken(Redacted.value(target.token)),
        HttpClientRequest.acceptJson,
      );
      const waitSeconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(input.waitSeconds)));
      const deadline = (yield* Clock.currentTimeMillis) + waitSeconds * 1000;
      for (;;) {
        const status = toStatus(
          yield* send({ operation: "read", request, requestId: input.requestId }),
        );
        const remaining = deadline - (yield* Clock.currentTimeMillis);
        if (remaining <= 0 || (status.status !== "pending" && !status.outcomePending)) {
          return status;
        }
        yield* Effect.sleep(Duration.min(POLL_INTERVAL, Duration.millis(remaining)));
      }
    });

  return UserRequestInbox.of({ create, read });
});

export const layer = Layer.effect(UserRequestInbox, make);
