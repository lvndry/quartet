/**
 * @fileoverview ACP v1 runtime adapter.
 *
 * One subprocess and one ACP connection serve the lifetime of this runtime. Quartet room
 * conversations are mapped to ACP sessions, so an agent retains its own context without the
 * hub or bridge having to know anything about the agent behind the protocol.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { CLOSE_SENTINEL, PASS_SENTINEL } from "@quartet/protocol";
import { webhookPromptTemplate } from "../prompt";
import type {
  RunTurnRequest,
  RuntimeConfigOption,
  RuntimeEvent,
  RuntimeInteraction,
  RuntimeInteractionAnswer,
  RuntimeOutcome,
  TurnRunner,
} from "./types";
import type { RuntimeConfigValue } from "@quartet/protocol";

/** A generous local boundary that still prevents accidentally feeding an agent unbounded data. */
export const MAX_ACP_PROMPT_BYTES = 1024 * 1024;

export interface AcpRuntimeOptions {
  /** Executable name or absolute path. It is passed directly to spawn, never through a shell. */
  readonly command: string;
  /** Individual argv entries passed to the executable. */
  readonly args?: readonly string[];
  /** Working directory for both the process and each ACP session. */
  readonly cwd?: string;
  /** Human-readable runtime name shown by Quartet. */
  readonly label?: string;
  /** Environment additions. Existing process variables remain available. */
  readonly env?: Readonly<Record<string, string>>;
  /** Retrieve a previously persisted ACP session for this Quartet conversation. */
  readonly loadSession?: (conversationId: string) => string | undefined | Promise<string | undefined>;
  /** Persist a newly created ACP session. The caller owns runtime/identity namespacing. */
  readonly saveSession?: (conversationId: string, sessionId: string) => void | Promise<void>;
  /**
   * Session config the operator has already chosen (configId → valueId), reapplied to every
   * session the agent starts. The agent's own default stands for anything absent here.
   */
  readonly desiredConfig?: Readonly<Record<string, string>>;
  /** Persist a changed config selection. The caller owns runtime/identity namespacing. */
  readonly persistConfig?: (config: Readonly<Record<string, string>>) => void | Promise<void>;
}

/** One ACP select value, whether it arrived loose or inside a group, as Quartet's shape. */
function toRuntimeValue(option: acp.SessionConfigSelectOption): RuntimeConfigValue {
  return {
    value: option.value,
    name: option.name,
    ...(option.description ? { description: option.description } : {}),
  };
}

/** Flatten an ACP select's values, dropping the group structure Quartet's UI does not use. */
function flattenSelectOptions(options: acp.SessionConfigSelectOptions): RuntimeConfigValue[] {
  const values: RuntimeConfigValue[] = [];
  for (const entry of options) {
    if ("options" in entry && Array.isArray(entry.options)) {
      for (const option of entry.options) values.push(toRuntimeValue(option));
    } else {
      values.push(toRuntimeValue(entry as acp.SessionConfigSelectOption));
    }
  }
  return values;
}

/**
 * Keep the select options — model, reasoning effort, mode — and drop the rest. Booleans are
 * omitted deliberately: Quartet does not advertise the client capability that permits them.
 */
function mapConfigOptions(
  raw: readonly acp.SessionConfigOption[] | null | undefined,
): RuntimeConfigOption[] {
  if (raw == null) return [];
  const mapped: RuntimeConfigOption[] = [];
  for (const option of raw) {
    if (option.type !== "select") continue;
    mapped.push({
      // ACP names the option `id`; its setter names the same value `configId`. Quartet uses the
      // setter's word throughout so a selection and the option it targets read the same.
      configId: option.id,
      name: option.name,
      ...(option.category ? { category: option.category } : {}),
      currentValue: option.currentValue,
      values: flattenSelectOptions(option.options),
    });
  }
  return mapped;
}

interface ActiveTurn {
  readonly request: RunTurnRequest;
  readonly tools: Map<string, { name: string; input?: unknown }>;
  text: string;
  cumulativeUsd?: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printable(value: unknown): unknown {
  if (value === undefined || typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function turnResult(text: string, costUSD?: number): RuntimeOutcome {
  const answer = text.trim();
  const cost = {
    ...(costUSD !== undefined ? { costUSD } : {}),
    incomplete: costUSD === undefined,
  };
  if (answer.length === 0) return { kind: "failed", reason: "the ACP agent returned an empty answer" };
  if (answer === PASS_SENTINEL) return { kind: "passed", cost };
  return { kind: "said", text: answer, cost, closing: answer.includes(CLOSE_SENTINEL) };
}

/** Fail the transport on invalid NDJSON instead of leaving the matching prompt pending. */
function validateNdJson(input: Readable): Transform {
  let pending = "";
  const output = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      try {
        for (const line of lines) {
          if (line.trim().length > 0) JSON.parse(line);
        }
      } catch {
        callback(new Error("ACP agent wrote malformed NDJSON"));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      try {
        if (pending.trim().length > 0) JSON.parse(pending);
        callback();
      } catch {
        callback(new Error("ACP agent wrote malformed NDJSON"));
      }
    },
  });
  input.pipe(output);
  return output;
}

/** Long-lived stable ACP v1 client for any command that exposes an ACP agent over stdio. */
export class AcpRuntime implements TurnRunner {
  readonly info;

  private child: ChildProcessWithoutNullStreams | undefined;
  private connection: acp.ClientConnection | undefined;
  private starting: Promise<acp.ClientConnection> | undefined;
  private intentionallyClosing = false;
  private stderr = "";
  private lastProcessFailure: string | undefined;
  private readonly sessions = new Map<string, Promise<string>>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly sessionCosts = new Map<string, number>();
  /** A resumed session's cumulative spend has no trustworthy pre-restart baseline. */
  private readonly restoredSessions = new Set<string>();
  private capabilities: acp.AgentCapabilities | undefined;
  /** The latest options the agent has disclosed, as Quartet's shape. Empty until a session exists. */
  private configCache: readonly RuntimeConfigOption[] = [];
  /** The operator's chosen values (configId → valueId), reapplied to every session. */
  private readonly desired: Map<string, string>;
  private configListener: ((options: readonly RuntimeConfigOption[]) => void) | undefined;

  constructor(private readonly options: AcpRuntimeOptions) {
    if (options.command.trim().length === 0) throw new Error("ACP command must not be empty");
    this.desired = new Map(Object.entries(options.desiredConfig ?? {}));
    this.info = {
      kind: "acp" as const,
      label: options.label?.trim() || "ACP agent",
      maxPromptBytes: MAX_ACP_PROMPT_BYTES,
    };
  }

  async run(request: RunTurnRequest): Promise<RuntimeOutcome> {
    if (Buffer.byteLength(request.prompt, "utf8") > this.info.maxPromptBytes) {
      return { kind: "failed", reason: "the turn prompt was too large for the ACP runtime" };
    }
    if (request.signal.aborted) return { kind: "failed", reason: "the ACP turn was cancelled" };

    try {
      const connection = await this.start();
      const sessionId = await this.sessionFor(connection, request.conversationId);
      if (request.signal.aborted) return { kind: "failed", reason: "the ACP turn was cancelled" };
      if (this.active.has(sessionId)) {
        return { kind: "failed", reason: "another turn is already running in this ACP session" };
      }

      const turn: ActiveTurn = { request, tools: new Map(), text: "" };
      this.active.set(sessionId, turn);
      const prompt = connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: this.renderPrompt(request.prompt) }],
      });
      let cancelling = false;
      const cancel = (): void => {
        if (cancelling) return;
        cancelling = true;
        void connection.agent
          .notify(acp.methods.agent.session.cancel, { sessionId })
          .catch(() => undefined);
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      // AbortSignal does not replay an abort that happened while the process/session was
      // starting. Close that race explicitly after installing the listener.
      if (request.signal.aborted) cancel();

      try {
        const response = await prompt;
        if (response.stopReason === "cancelled" || request.signal.aborted) {
          return { kind: "failed", reason: "the ACP turn was cancelled" };
        }

        const previous = this.sessionCosts.get(sessionId);
        const current = turn.cumulativeUsd;
        if (current !== undefined) this.sessionCosts.set(sessionId, current);
        const costUSD =
          current === undefined || (previous === undefined && this.restoredSessions.has(sessionId))
            ? undefined
            : previous === undefined
              ? current
              : current >= previous
                ? current - previous
                : undefined;
        this.restoredSessions.delete(sessionId);
        return turnResult(turn.text, costUSD);
      } finally {
        request.signal.removeEventListener("abort", cancel);
        if (this.active.get(sessionId) === turn) this.active.delete(sessionId);
      }
    } catch (error) {
      return { kind: "failed", reason: await this.failureReason(error) };
    }
  }

  /** Stop only the child this runtime created; a subsequent run starts a fresh connection. */
  async close(): Promise<void> {
    this.intentionallyClosing = true;
    const connection = this.connection;
    const child = this.child;
    this.reset(connection);
    connection?.close();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 1_000);
        child.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    this.intentionallyClosing = false;
  }

  private renderPrompt(payload: string): string {
    return webhookPromptTemplate().replace("{{payload}}", payload);
  }

  private start(): Promise<acp.ClientConnection> {
    if (this.connection !== undefined && !this.connection.signal.aborted) {
      return Promise.resolve(this.connection);
    }
    if (this.starting !== undefined) return this.starting;
    const starting = this.open();
    this.starting = starting;
    const clear = (): void => {
      if (this.starting === starting) this.starting = undefined;
    };
    // `finally` would create a second rejected promise on startup failure. Attach both
    // branches explicitly so an absent executable is returned to the turn, not process-wide.
    void starting.then(clear, clear);
    return starting;
  }

  private async open(): Promise<acp.ClientConnection> {
    this.stderr = "";
    this.lastProcessFailure = undefined;
    const child = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: resolve(this.options.cwd ?? process.cwd()),
      env: { ...process.env, ...this.options.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4_096);
    });
    child.once("error", (error) => {
      this.lastProcessFailure = message(error);
    });
    child.once("exit", (code, signal) => {
      if (this.intentionallyClosing) return;
      this.lastProcessFailure = `process exited${code === null ? "" : ` with code ${String(code)}`}${signal === null ? "" : ` from ${signal}`}`;
    });

    const app = acp
      .client({ name: "Quartet" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.onSessionUpdate(ctx.params);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.onPermissionRequest(ctx.params),
      )
      .onRequest(acp.methods.client.elicitation.create, (ctx) =>
        this.onElicitationRequest(ctx.params),
      );

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(validateNdJson(child.stdout)) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    this.connection = connection;

    const childFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (this.intentionallyClosing) return;
        reject(
          new Error(
            `ACP process exited${code === null ? "" : ` with code ${String(code)}`}${signal === null ? "" : ` from ${signal}`}`,
          ),
        );
      });
    });

    try {
      const initialized = connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // Quartet's current question UI represents one prompt, not an arbitrary form. Do
        // not claim the wider capability until every advertised schema can be rendered.
        clientCapabilities: {},
        clientInfo: { name: "Quartet", version: "0.1.0" },
      });
      const response = await Promise.race([initialized, childFailure]);
      if (response.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`ACP protocol version ${String(response.protocolVersion)} is not supported`);
      }
      this.capabilities = response.agentCapabilities;
    } catch (error) {
      connection.close(error);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      this.reset(connection);
      throw error;
    }

    void connection.closed.then(() => {
      if (this.connection !== connection) return;
      if (!this.intentionallyClosing && child.exitCode === null && child.signalCode === null) child.kill();
      this.reset(connection);
    });
    return connection;
  }

  private sessionFor(connection: acp.ClientConnection, conversationId: string): Promise<string> {
    const existing = this.sessions.get(conversationId);
    if (existing !== undefined) return existing;
    const created = this.restoreOrCreateSession(connection, conversationId)
      .catch((error: unknown) => {
        if (this.sessions.get(conversationId) === created) this.sessions.delete(conversationId);
        throw error;
      });
    this.sessions.set(conversationId, created);
    return created;
  }

  private async restoreOrCreateSession(
    connection: acp.ClientConnection,
    conversationId: string,
  ): Promise<string> {
    const cwd = resolve(this.options.cwd ?? process.cwd());
    const persisted = await this.options.loadSession?.(conversationId);
    if (persisted !== undefined && persisted.length > 0) {
      if (this.capabilities?.sessionCapabilities?.resume !== undefined) {
        try {
          const resumed = await connection.agent.request(acp.methods.agent.session.resume, {
            sessionId: persisted,
            cwd,
            mcpServers: [],
          });
          this.restoredSessions.add(persisted);
          await this.absorbConfig(connection, persisted, resumed.configOptions);
          return persisted;
        } catch {
          // An agent may have lost the resumable process state but retained loadable history.
        }
      }
      if (this.capabilities?.loadSession === true) {
        try {
          const loaded = await connection.agent.request(acp.methods.agent.session.load, {
            sessionId: persisted,
            cwd,
            mcpServers: [],
          });
          this.restoredSessions.add(persisted);
          await this.absorbConfig(connection, persisted, loaded.configOptions);
          return persisted;
        } catch {
          // The durable id is stale for this agent; create and persist its replacement below.
        }
      }
    }
    const created = await connection.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
    await this.options.saveSession?.(conversationId, created.sessionId);
    await this.absorbConfig(connection, created.sessionId, created.configOptions);
    return created.sessionId;
  }

  /**
   * Learn what the agent offers for this session and reassert the operator's saved choices,
   * because a fresh session starts at the agent's defaults. A rejected reassertion leaves that
   * one option at the default rather than failing the session.
   */
  private async absorbConfig(
    connection: acp.ClientConnection,
    sessionId: string,
    raw: readonly acp.SessionConfigOption[] | null | undefined,
  ): Promise<void> {
    let options = mapConfigOptions(raw);
    for (const option of options) {
      const wanted = this.desired.get(option.configId);
      if (wanted === undefined || wanted === option.currentValue) continue;
      if (!option.values.some((value) => value.value === wanted)) continue;
      try {
        const response = await connection.agent.request(
          acp.methods.agent.session.setConfigOption,
          { sessionId, configId: option.configId, value: wanted },
        );
        options = mapConfigOptions(response.configOptions);
      } catch {
        // Keep the agent's default for this option.
      }
    }
    this.publishConfig(options);
  }

  private publishConfig(options: readonly RuntimeConfigOption[]): void {
    if (JSON.stringify(options) === JSON.stringify(this.configCache)) return;
    this.configCache = options;
    this.configListener?.(options);
  }

  configOptions(): readonly RuntimeConfigOption[] {
    return this.configCache;
  }

  onConfigOptions(listener: (options: readonly RuntimeConfigOption[]) => void): void {
    this.configListener = listener;
  }

  /**
   * Read the agent's options without a room to hang them on, by opening one throwaway session
   * and closing it again. Skipped once options are known — a real session keeps them fresh —
   * and collapsed so concurrent callers share one probe.
   */
  async discoverConfig(): Promise<readonly RuntimeConfigOption[]> {
    if (this.configCache.length > 0) return this.configCache;
    if (this.discovering === undefined) {
      this.discovering = this.probeConfig().finally(() => {
        this.discovering = undefined;
      });
    }
    try {
      await this.discovering;
    } catch {
      // Leave the cache empty; the screen shows "no settings disclosed" rather than an error.
    }
    return this.configCache;
  }

  private discovering: Promise<void> | undefined;

  private async probeConfig(): Promise<void> {
    const connection = await this.start();
    const created = await connection.agent.request(acp.methods.agent.session.new, {
      cwd: resolve(this.options.cwd ?? process.cwd()),
      mcpServers: [],
    });
    await this.absorbConfig(connection, created.sessionId, created.configOptions);
    try {
      await connection.agent.request(acp.methods.agent.session.close, {
        sessionId: created.sessionId,
      });
    } catch {
      // An agent that cannot close a session is left holding one idle throwaway.
    }
  }

  async setConfigOption(
    configId: string,
    valueId: string,
  ): Promise<readonly RuntimeConfigOption[]> {
    this.desired.set(configId, valueId);
    await this.options.persistConfig?.(Object.fromEntries(this.desired));

    let appliedLive = false;
    const connection = this.connection;
    if (connection !== undefined && !connection.signal.aborted) {
      for (const pending of this.sessions.values()) {
        let sessionId: string;
        try {
          sessionId = await pending;
        } catch {
          continue;
        }
        try {
          const response = await connection.agent.request(
            acp.methods.agent.session.setConfigOption,
            { sessionId, configId, value: valueId },
          );
          this.publishConfig(mapConfigOptions(response.configOptions));
          appliedLive = true;
        } catch {
          // A single session refusing the change should not sink the others.
        }
      }
    }

    // Only when no live session answered — the agent's own response is authoritative and may
    // have adjusted more than this one value, so it is never overwritten with a guess.
    if (!appliedLive) {
      this.publishConfig(
        this.configCache.map((option) =>
          option.configId === configId ? { ...option, currentValue: valueId } : option,
        ),
      );
    }
    return this.configCache;
  }

  private onSessionUpdate(notification: acp.SessionNotification): void {
    const update = notification.update;
    // The agent can change models or effort on its own, and does so between turns as well as
    // during one, so this is read before the active-turn gate below.
    if (update.sessionUpdate === "config_option_update") {
      this.publishConfig(mapConfigOptions(update.configOptions));
      return;
    }
    const turn = this.active.get(notification.sessionId);
    if (turn === undefined) return;
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text") turn.text += update.content.text;
      turn.request.onEvent({ kind: "progress" });
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      if (update.cost?.currency.toUpperCase() === "USD") turn.cumulativeUsd = update.cost.amount;
      turn.request.onEvent({ kind: "progress" });
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.onToolUpdate(turn, update);
      return;
    }
    turn.request.onEvent({ kind: "progress" });
  }

  private onToolUpdate(turn: ActiveTurn, update: acp.ToolCall | acp.ToolCallUpdate): void {
    const prior = turn.tools.get(update.toolCallId);
    const name = update.name ?? update.title ?? prior?.name ?? update.kind ?? "tool";
    const input = update.rawInput ?? prior?.input;
    turn.tools.set(update.toolCallId, { name, ...(input !== undefined ? { input } : {}) });
    const finished = update.status === "completed" || update.status === "failed";
    const event: RuntimeEvent = finished
      ? {
          kind: "tool-finished",
          toolName: name,
          toolCallId: update.toolCallId,
          ok: update.status !== "failed",
          ...(update.rawOutput !== undefined ? { result: printable(update.rawOutput) } : {}),
          ...(update.status === "failed" ? { error: String(printable(update.rawOutput) ?? "tool failed") } : {}),
        }
      : {
          kind: "tool-started",
          toolName: name,
          toolCallId: update.toolCallId,
          ...(input !== undefined ? { input } : {}),
        };
    turn.request.onEvent(event);
  }

  private async onPermissionRequest(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const turn = this.active.get(params.sessionId);
    if (turn === undefined) return { outcome: { outcome: "cancelled" } };
    const prior = turn.tools.get(params.toolCall.toolCallId);
    const name = params.toolCall.name ?? params.toolCall.title ?? prior?.name ?? "tool";
    turn.request.onEvent({
      kind: "approval-required",
      toolName: name,
      toolCallId: params.toolCall.toolCallId,
      ...(params.toolCall.rawInput !== undefined ? { input: params.toolCall.rawInput } : {}),
    });

    let answer: RuntimeInteractionAnswer;
    try {
      const received = await this.requestInteraction(
        turn,
        `acp:${params.sessionId}:${params.toolCall.toolCallId}:${crypto.randomUUID()}`,
        { kind: "approval", ...(params.toolCall.title ? { message: params.toolCall.title } : {}) },
      );
      if (received === undefined) return { outcome: { outcome: "cancelled" } };
      answer = received;
    } catch {
      return { outcome: { outcome: "cancelled" } };
    }
    // The Quartet UI asks about this operation, not a policy change. Never turn one click
    // into a standing permission merely because the agent listed `allow_always` first.
    const desired = answer.approved ? "allow_once" : "reject_once";
    const selected = params.options.find((option) => option.kind === desired);
    return selected === undefined
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId: selected.optionId } };
  }

  private async onElicitationRequest(
    params: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    if (!acp.CreateElicitationRequest.isForm(params) || !("sessionId" in params)) {
      return { action: "decline" };
    }
    const turn = this.active.get(params.sessionId);
    if (turn === undefined) return { action: "cancel" };
    const properties = Object.entries(params.requestedSchema.properties ?? {});
    const first = properties[0];
    const schema = first?.[1];
    const suggestions =
      schema !== undefined && acp.ElicitationPropertySchema.isString(schema)
        ? [
            ...(schema.enum ?? []).map((value) => ({ value })),
            ...(schema.oneOf ?? []).map((option) => ({
              value: option.const,
              label: option.title,
              ...(option.description ? { description: option.description } : {}),
            })),
          ]
        : [];
    const answer = await this.requestInteraction(turn, `acp:${params.sessionId}:${crypto.randomUUID()}`, {
      kind: "question",
      question: {
        question: params.message,
        suggestions,
        allowCustom: suggestions.length === 0,
        allowMultiple:
          schema !== undefined && acp.ElicitationPropertySchema.isArray(schema),
      },
    });
    if (answer === undefined || !answer.approved || answer.response === undefined) {
      return { action: "decline" };
    }
    if (first === undefined) return { action: "accept", content: {} };
    return { action: "accept", content: { [first[0]]: answer.response } };
  }

  /** ACP requires pending client requests to settle when a prompt is cancelled. */
  private requestInteraction(
    turn: ActiveTurn,
    runId: string,
    pending: RuntimeInteraction,
  ): Promise<RuntimeInteractionAnswer | undefined> {
    if (turn.request.signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (answer: RuntimeInteractionAnswer | undefined): void => {
        if (settled) return;
        settled = true;
        turn.request.signal.removeEventListener("abort", cancelled);
        resolve(answer);
      };
      const cancelled = (): void => finish(undefined);
      turn.request.signal.addEventListener("abort", cancelled, { once: true });
      void turn.request.requestInteraction(runId, pending).then(finish, () => finish(undefined));
    });
  }

  private async failureReason(error: unknown): Promise<string> {
    // stdout commonly closes a tick before Node delivers the child's exit event. Give that
    // event a brief chance to replace the generic transport error with the useful exit code.
    if (this.lastProcessFailure === undefined && message(error).includes("connection closed")) {
      await new Promise<void>((done) => setTimeout(done, 20));
    }
    const detail = this.stderr.trim();
    const suffix = detail.length === 0 ? "" : `: ${detail}`;
    return `ACP agent failed: ${this.lastProcessFailure ?? message(error)}${suffix}`;
  }

  private reset(connection: acp.ClientConnection | undefined): void {
    if (connection !== undefined && this.connection !== connection) return;
    this.connection = undefined;
    this.child = undefined;
    this.sessions.clear();
    this.active.clear();
    this.sessionCosts.clear();
    this.restoredSessions.clear();
    this.capabilities = undefined;
    // The disclosed options belonged to sessions that no longer exist; the desired selections
    // are kept, to be reasserted once a session comes back.
    this.publishConfig([]);
  }
}
