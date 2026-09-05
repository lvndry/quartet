import { describe, expect, it } from "bun:test";
import type { Message } from "@quartet/protocol";
import { missingOutgoing } from "./ledger";

function agentLine(id: string, did: string, text: string): Message {
  return {
    id,
    conversationId: "cnv_1",
    authorDid: did,
    kind: "agent",
    text,
    at: "2026-09-02T00:00:00.000Z",
  };
}

describe("ledger catch-up", () => {
  it("asks only for your confirmed agent lines the file does not have", () => {
    const known = new Set(["msg_already"]);
    const missing = missingOutgoing(
      [
        agentLine("msg_already", "mira", "already on disk"),
        agentLine("msg_gap", "mira", "hub has this, file does not"),
        agentLine("msg_theirs", "otto", "not ours"),
        {
          ...agentLine("msg_pass", "mira", ""),
          kind: "pass",
        },
      ],
      "mira",
      known,
    );

    expect(missing.map((message) => message.id)).toEqual(["msg_gap"]);
  });

  it("asks for nothing when the file already matches the room", () => {
    const messages = [agentLine("msg_1", "mira", "hello")];
    expect(missingOutgoing(messages, "mira", new Set(["msg_1"]))).toEqual([]);
  });
});
