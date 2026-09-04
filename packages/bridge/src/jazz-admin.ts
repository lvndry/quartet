/**
 * @fileoverview Managing jazz's agents over its daemon, so the app can do it instead of a terminal.
 *
 * Kept apart from `jazz-agents.ts`, which answers one question for the setup wizard — which
 * agents exist. This is the rest of the surface: creating and editing them, and the
 * catalogues an editor's menus are built from.
 *
 * **Nothing here holds a rule about what a valid agent is.** jazz validates every field and
 * answers a refusal naming the offending one, so a form here can post and put the message on
 * the right input. Re-implementing those rules on this side would create a second, quietly
 * diverging copy — and the menus exist precisely so the UI cannot offer a value jazz rejects.
 */

import type { DaemonSettings } from "./config";

/** Full config, minus the api keys jazz will not hand out. Shape follows jazz's own. */
export type JazzAgentConfig = Readonly<Record<string, unknown>>;

/** One agent in full, as `GET /agents/:id` answers. */
export interface JazzAgentDetail {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly persona: string;
  readonly provider: string;
  readonly model: string;
  readonly tools: readonly string[];
  readonly config: JazzAgentConfig;
  /**
   * Providers with a per-agent key override.
   *
   * The keys themselves are never served, so this is how an editor says "a key is set"
   * honestly instead of rendering a blank box that means either "unset" or "hidden".
   */
  readonly apiKeyProviders: readonly string[];
}

/** The fixed vocabularies. Exactly the arrays jazz validates against. */
export interface JazzCatalog {
  readonly providers: readonly string[];
  readonly webSearchProviders: readonly string[];
  readonly reasoningEfforts: readonly string[];
  /**
   * The jobs an agent can bind a companion for, each `"<action>:<modality>"`.
   *
   * Action and modality are separate axes because a model rarely does both — most models
   * that read an image cannot draw one — so `analyze:image` and `generate:image` are
   * independent slots on the same agent.
   */
  readonly companionRoles: readonly string[];
}

/**
 * One model a provider serves.
 *
 * The capability flags are not description, they are what makes a form field meaningful:
 * a temperature input on a model that ignores temperature is a control that silently does
 * nothing, and every current Claude reasoning model reports `supportsTemperature: false`.
 */
export interface JazzModel {
  readonly id: string;
  readonly displayName?: string;
  readonly supportsTools: boolean;
  readonly supportsTemperature: boolean;
  readonly isReasoningModel: boolean;
  readonly inputPricePerMillion?: number;
  readonly outputPricePerMillion?: number;
}

export interface JazzPersona {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tone?: string;
  readonly style?: string;
}

export interface JazzTools {
  readonly tools: readonly string[];
  readonly categories: Readonly<Record<string, readonly string[]>>;
  /**
   * Which tools an agent gets whether or not anyone asked for them.
   *
   * Required, because a tool picker cannot be honest without it: `config.tools` only ever
   * adds, so without knowing which tools arrive anyway a checkbox cannot say whether
   * unticking it would do anything. A jazz too old to report it is therefore a jazz too old
   * to edit tools from here, and `unsupported` says so rather than the UI guessing.
   */
  readonly defaultTools: readonly string[];
}

/**
 * What asking jazz for something came to, in terms a caller can act on.
 *
 * Split this finely because each outcome needs something different said, and a UI that
 * collapses them says "something went wrong" to somebody whose daemon is simply not running.
 * `rejected` is the one that carries jazz's own `field` and `suggestion` through, so a form
 * can mark the input that was wrong rather than showing a banner.
 */
export type JazzResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "unreachable" }
  | { readonly kind: "unauthorized" }
  /** This jazz is too old to have the route at all. Probed once, not guessed per request. */
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "rejected";
      readonly error: string;
      readonly field?: string;
      readonly suggestion?: string;
    }
  | { readonly kind: "failed"; readonly detail: string };

interface CallOptions {
  readonly method?: string;
  readonly body?: unknown;
  /**
   * How to read a 404.
   *
   * An old jazz's catch-all and a real "no such agent" are the same status with the same
   * JSON, so this cannot be inferred per request. Only the catalogue probe reads it as
   * `unsupported`; once that has answered, the app knows whether the routes exist and every
   * other 404 means the thing asked for is not there.
   */
  readonly missingMeans?: "unsupported" | "rejected";
}

async function callJazz<T>(
  daemon: DaemonSettings,
  path: string,
  read: (body: Record<string, unknown>) => T | undefined,
  options: CallOptions = {},
): Promise<JazzResult<T>> {
  let response: Response;
  try {
    response = await fetch(new URL(path, daemon.url), {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    return { kind: "unreachable" };
  }

  if (response.status === 401) return { kind: "unauthorized" };

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (response.status === 404 && (options.missingMeans ?? "rejected") === "unsupported") {
    return { kind: "unsupported" };
  }

  if (!response.ok) {
    const error = typeof body?.["error"] === "string" ? (body["error"] as string) : undefined;
    if (error === undefined) {
      return { kind: "failed", detail: `the daemon answered ${String(response.status)}` };
    }
    const field = typeof body?.["field"] === "string" ? (body["field"] as string) : undefined;
    const suggestion =
      typeof body?.["suggestion"] === "string" ? (body["suggestion"] as string) : undefined;
    return {
      kind: "rejected",
      error,
      ...(field !== undefined ? { field } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
    };
  }

  if (body === null) return { kind: "failed", detail: "the daemon answered something not JSON" };
  const value = read(body);
  return value === undefined
    ? { kind: "unsupported" }
    : { kind: "ok", value };
}

function text(record: Record<string, unknown>, key: string): string | undefined {
  const found = record[key];
  return typeof found === "string" && found.length > 0 ? found : undefined;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toDetail(raw: unknown): JazzAgentDetail | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = text(record, "id");
  const name = text(record, "name");
  const config = record["config"];
  if (id === undefined || name === undefined || typeof config !== "object" || config === null) {
    return undefined;
  }
  const description = text(record, "description");
  return {
    id,
    name,
    ...(description !== undefined ? { description } : {}),
    persona: text(record, "persona") ?? "default",
    provider: text(record, "provider") ?? "",
    model: text(record, "model") ?? "",
    tools: strings(record["tools"]),
    config: config as JazzAgentConfig,
    apiKeyProviders: strings(record["apiKeyProviders"]),
  };
}

/**
 * The catalogue, and the probe for whether this jazz can be managed at all.
 *
 * Called once when the bridge starts. `unsupported` here is what tells the app to show
 * "update jazz" rather than an editor whose every save would 404 — and having asked, a 404
 * from any other route can be read as "not there" instead of "route missing".
 */
export function fetchJazzCatalog(daemon: DaemonSettings): Promise<JazzResult<JazzCatalog>> {
  return callJazz(
    daemon,
    "/catalog",
    (body) => {
      const providers = strings(body["providers"]);
      if (providers.length === 0) return undefined;
      return {
        providers,
        webSearchProviders: strings(body["webSearchProviders"]),
        reasoningEfforts: strings(body["reasoningEfforts"]),
        companionRoles: strings(body["companionRoles"]),
      };
    },
    { missingMeans: "unsupported" },
  );
}

/**
 * A provider's models, or only the ones that can do `role`.
 *
 * The filtering and the order are jazz's, not this file's: "capable, best first" means priced
 * before unpriced and then cheapest, and re-deciding that here would disagree with what
 * jazz's own picker recommends for the same question.
 */
export function fetchJazzModels(
  daemon: DaemonSettings,
  provider: string,
  role?: string,
): Promise<JazzResult<readonly JazzModel[]>> {
  const query = role === undefined ? "" : `&role=${encodeURIComponent(role)}`;
  return callJazz(daemon, `/models?provider=${encodeURIComponent(provider)}${query}`, (body) => {
    if (!Array.isArray(body["models"])) return undefined;
    return body["models"]
      .map((raw): JazzModel | undefined => {
        if (typeof raw !== "object" || raw === null) return undefined;
        const record = raw as Record<string, unknown>;
        const id = text(record, "id");
        if (id === undefined) return undefined;
        const displayName = text(record, "displayName");
        const price = (key: string): number | undefined =>
          typeof record[key] === "number" ? (record[key] as number) : undefined;
        const inputPricePerMillion = price("inputPricePerMillion");
        const outputPricePerMillion = price("outputPricePerMillion");
        return {
          id,
          ...(displayName !== undefined ? { displayName } : {}),
          supportsTools: record["supportsTools"] === true,
          // Absent means yes: jazz only says false when the catalogue is sure, and treating
          // silence as "no" would hide the field on every model it knows nothing about.
          supportsTemperature: record["supportsTemperature"] !== false,
          isReasoningModel: record["isReasoningModel"] === true,
          ...(inputPricePerMillion !== undefined ? { inputPricePerMillion } : {}),
          ...(outputPricePerMillion !== undefined ? { outputPricePerMillion } : {}),
        };
      })
      .filter((model): model is JazzModel => model !== undefined);
  });
}

export function fetchJazzPersonas(
  daemon: DaemonSettings,
): Promise<JazzResult<readonly JazzPersona[]>> {
  return callJazz(daemon, "/personas", (body) => {
    if (!Array.isArray(body["personas"])) return undefined;
    return body["personas"]
      .map((raw): JazzPersona | undefined => {
        if (typeof raw !== "object" || raw === null) return undefined;
        const record = raw as Record<string, unknown>;
        const id = text(record, "id");
        const name = text(record, "name");
        if (id === undefined || name === undefined) return undefined;
        const tone = text(record, "tone");
        const style = text(record, "style");
        return {
          id,
          name,
          description: text(record, "description") ?? "",
          ...(tone !== undefined ? { tone } : {}),
          ...(style !== undefined ? { style } : {}),
        };
      })
      .filter((persona): persona is JazzPersona => persona !== undefined);
  });
}

export function fetchJazzTools(daemon: DaemonSettings): Promise<JazzResult<JazzTools>> {
  return callJazz(daemon, "/tools", (body) => {
    if (!Array.isArray(body["tools"])) return undefined;
    const raw = body["categories"];
    const categories: Record<string, readonly string[]> = {};
    if (typeof raw === "object" && raw !== null) {
      for (const [category, names] of Object.entries(raw as Record<string, unknown>)) {
        categories[category] = strings(names);
      }
    }
    if (!Array.isArray(body["defaultTools"])) return undefined;
    return {
      tools: strings(body["tools"]),
      categories,
      defaultTools: strings(body["defaultTools"]),
    };
  });
}

export function fetchJazzAgentDetail(
  daemon: DaemonSettings,
  identifier: string,
): Promise<JazzResult<JazzAgentDetail>> {
  return callJazz(daemon, `/agents/${encodeURIComponent(identifier)}`, (body) =>
    toDetail(body["agent"]),
  );
}

export function createJazzAgent(
  daemon: DaemonSettings,
  draft: { readonly name: string; readonly description?: string; readonly config: JazzAgentConfig },
): Promise<JazzResult<JazzAgentDetail>> {
  return callJazz(daemon, "/agents", (body) => toDetail(body["agent"]), {
    method: "POST",
    body: draft,
  });
}

/**
 * Change some of an agent, leaving the rest alone.
 *
 * A PATCH because jazz merges the config shallowly: fields left out keep their stored value.
 * The consequence worth knowing is that there is no way to *unset* an optional field through
 * it — omitting one keeps it, and sending null sets it to null.
 */
export function updateJazzAgent(
  daemon: DaemonSettings,
  identifier: string,
  changes: {
    readonly name?: string;
    readonly description?: string;
    readonly config?: JazzAgentConfig;
  },
): Promise<JazzResult<JazzAgentDetail>> {
  return callJazz(
    daemon,
    `/agents/${encodeURIComponent(identifier)}`,
    (body) => toDetail(body["agent"]),
    { method: "PATCH", body: changes },
  );
}

export function deleteJazzAgent(
  daemon: DaemonSettings,
  identifier: string,
): Promise<JazzResult<string>> {
  return callJazz(daemon, `/agents/${encodeURIComponent(identifier)}`, (body) => text(body, "id"), {
    method: "DELETE",
  });
}
