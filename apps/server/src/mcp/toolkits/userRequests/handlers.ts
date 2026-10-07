import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as UserRequestInbox from "../../../userRequests/UserRequestInbox.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { UserRequestsToolkit } from "./tools.ts";

const failWith =
  (code: "capability_denied" | "invalid_request" | "orchestration_error") =>
  (error: UserRequestInbox.UserRequestInboxError) =>
    Effect.fail(new OrchestratorMcpFailure({ code, message: error.message }));

/**
 * The service's messages are fixed or built from bounded attributes, never the
 * inbox URL, token or file path, so they pass through to the agent as is.
 */
const toToolFailure = {
  UserRequestInboxNotConfiguredError: failWith("capability_denied"),
  UserRequestInboxUnsafeConfigError: failWith("capability_denied"),
  UserRequestNotFoundError: failWith("invalid_request"),
  UserRequestInboxRejectedError: failWith("invalid_request"),
  UserRequestInboxBusyError: failWith("orchestration_error"),
  UserRequestInboxUnavailableError: failWith("orchestration_error"),
} as const;

export const layer = McpToolAccess.toLayer(
  UserRequestsToolkit,
  Effect.gen(function* () {
    const inbox = yield* UserRequestInbox.UserRequestInbox;
    return {
      t3_user_request_create: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireThreadScope(
            yield* McpInvocationContext.McpInvocationContext,
            "t3_user_request_create",
          );
          return yield* inbox
            .create({
              threadId: scope.thread.threadId,
              environmentId: scope.environmentId,
              providerSessionId: scope.thread.providerSessionId,
              providerInstanceId: scope.thread.providerInstanceId,
              requestNamespace: scope.requestNamespace,
              request: input,
            })
            .pipe(Effect.catchTags(toToolFailure));
        }),
      ),
      t3_user_request_status: McpToolAccess.readsAsCaller((input) =>
        inbox
          .read({ requestId: input.id, waitSeconds: input.waitSeconds ?? 0 })
          .pipe(Effect.catchTags(toToolFailure)),
      ),
    };
  }),
);
