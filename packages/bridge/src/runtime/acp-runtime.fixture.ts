import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

let nextSession = 1;
const turns = new Map<string, number>();
const cancellations = new Map<string, () => void>();
const config = new Map<string, { model: string; effort: string }>();

function configFor(sessionId: string) {
  const state = config.get(sessionId) ?? { model: "sonnet", effort: "medium" };
  config.set(sessionId, state);
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: state.model,
      options: [
        { value: "sonnet", name: "Sonnet" },
        { value: "opus", name: "Opus" },
      ],
    },
    {
      id: "effort",
      name: "Reasoning",
      category: "thought_level",
      type: "select" as const,
      currentValue: state.effort,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ];
}

const app = acp
  .agent({ name: "quartet-test-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { sessionCapabilities: { resume: {} } },
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = `session-${String(nextSession++)}`;
    turns.set(sessionId, 0);
    return { sessionId, configOptions: configFor(sessionId) };
  })
  .onRequest(acp.methods.agent.session.resume, (ctx) => {
    turns.set(ctx.params.sessionId, turns.get(ctx.params.sessionId) ?? 0);
    return { configOptions: configFor(ctx.params.sessionId) };
  })
  .onRequest(acp.methods.agent.session.close, () => ({}))
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    const state = config.get(ctx.params.sessionId) ?? { model: "sonnet", effort: "medium" };
    if (ctx.params.configId === "model") state.model = String(ctx.params.value);
    if (ctx.params.configId === "effort") state.effort = String(ctx.params.value);
    config.set(ctx.params.sessionId, state);
    return { configOptions: configFor(ctx.params.sessionId) };
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    cancellations.get(ctx.params.sessionId)?.();
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const block = ctx.params.prompt[0];
    const prompt = block?.type === "text" ? block.text : "";
    if (prompt.includes("FIXTURE_EXIT")) process.exit(17);
    if (prompt.includes("FIXTURE_MALFORMED")) {
      process.stdout.write("{not json}\n");
      await new Promise(() => undefined);
    }
    if (prompt.includes("FIXTURE_CANCEL")) {
      await new Promise<void>((done) => cancellations.set(ctx.params.sessionId, done));
      cancellations.delete(ctx.params.sessionId);
      return { stopReason: "cancelled" };
    }

    if (prompt.includes("FIXTURE_CONFIG_PUSH")) {
      const state = config.get(ctx.params.sessionId) ?? { model: "sonnet", effort: "medium" };
      state.effort = "high";
      config.set(ctx.params.sessionId, state);
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: configFor(ctx.params.sessionId) },
      });
    }

    const count = (turns.get(ctx.params.sessionId) ?? 0) + 1;
    turns.set(ctx.params.sessionId, count);
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "secret thought" },
      },
    });
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Inspect fixture",
        name: "inspect",
        status: "in_progress",
        rawInput: { path: "fixture" },
      },
    });
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { found: true },
      },
    });

    let permission = "none";
    if (prompt.includes("FIXTURE_PERMISSION")) {
      const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId: ctx.params.sessionId,
        toolCall: { toolCallId: "danger", title: "Dangerous fixture action", name: "danger" },
        options: [
          { optionId: "forever", name: "Always allow", kind: "allow_always" },
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      permission = response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled";
    }

    for (const text of [`${ctx.params.sessionId}/${String(count)}`, `/${permission}`]) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    }
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: count,
        size: 100,
        cost: { amount: count * 0.25, currency: "USD" },
      },
    });
    return { stopReason: "end_turn" };
  });

app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
