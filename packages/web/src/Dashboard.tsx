/**
 * @fileoverview Your agents, as a roster.
 *
 * Not a settings page: these are the players on this machine, and exactly one of them is on
 * stage — the agent that speaks for you in every room. The list marks that one the way the
 * rest of the app marks live things, because "which agent is answering" is the fact somebody
 * opens this screen to check.
 *
 * Every menu is served by jazz rather than typed out here. The provider list, the personas,
 * the models a provider really serves and the tools that exist are the same values jazz
 * validates against, so a picker structurally cannot offer something a save would reject —
 * and a hardcoded list would drift the day jazz adds a provider. The form does not
 * re-implement jazz's rules either: it posts, and a refusal comes back naming the field it
 * concerns, which is put on that input.
 */

import { useEffect, useState, type ReactElement } from "react";
import {
  read,
  type BridgeState,
  type JazzAgentDetail,
  type JazzModel,
  type JazzPersona,
  type JazzTools,
  type Refusal,
} from "./store";

/** The part of an agent's config this editor manages. Anything else is left untouched. */
interface Draft {
  name: string;
  description: string;
  persona: string;
  llmProvider: string;
  llmModel: string;
  summarizerModel: string;
  reasoningEffort: string;
  temperature: string;
  maxContextTokens: string;
  numCtx: string;
  webSearchProvider: string;
  memoryScopes: string;
  envAllowlist: string;
  tools: string[];
  deniedTools: string[];
  /** Modality to `"provider/model"`. Only bound modalities appear. */
  companions: Record<string, string>;
}

const BLANK: Draft = {
  name: "",
  description: "",
  persona: "default",
  llmProvider: "",
  llmModel: "",
  summarizerModel: "",
  reasoningEffort: "",
  temperature: "",
  maxContextTokens: "",
  numCtx: "",
  webSearchProvider: "",
  memoryScopes: "",
  envAllowlist: "",
  tools: [],
  deniedTools: [],
  companions: {},
};

function textOf(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function listOf(config: Record<string, unknown>, key: string): string[] {
  const value = config[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function draftFrom(detail: JazzAgentDetail): Draft {
  return {
    name: detail.name,
    description: detail.description ?? "",
    persona: detail.persona,
    llmProvider: detail.provider,
    llmModel: detail.model,
    summarizerModel: textOf(detail.config, "summarizerModel"),
    reasoningEffort: textOf(detail.config, "reasoningEffort"),
    temperature: textOf(detail.config, "temperature"),
    maxContextTokens: textOf(detail.config, "maxContextTokens"),
    numCtx: textOf(detail.config, "numCtx"),
    webSearchProvider: textOf(detail.config, "webSearchProvider"),
    memoryScopes: listOf(detail.config, "memoryScopes").join(", "),
    envAllowlist: listOf(detail.config, "envAllowlist").join(", "),
    tools: listOf(detail.config, "tools"),
    deniedTools: listOf(detail.config, "deniedTools"),
    companions: companionsOf(detail.config),
  };
}

function companionsOf(config: Record<string, unknown>): Record<string, string> {
  const raw = config["companions"];
  if (typeof raw !== "object" || raw === null) return {};
  const bound: Record<string, string> = {};
  for (const [capability, model] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof model === "string" && model.length > 0) bound[capability] = model;
  }
  return bound;
}

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * A number as jazz should store it, or null to stop storing one.
 *
 * `null` rather than dropping the key, because a shallow merge cannot unset a field — an
 * omitted key keeps whatever is on disk. jazz's validation skips null and its runtime only
 * reads these when they are numbers, so null is how "no longer set" survives a PATCH.
 */
function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** The config patch for a draft. Keys this editor does not manage stay absent, so they survive. */
function configFrom(draft: Draft): Record<string, unknown> {
  return {
    persona: draft.persona,
    llmProvider: draft.llmProvider,
    llmModel: draft.llmModel.trim(),
    summarizerModel: stringOrNull(draft.summarizerModel),
    reasoningEffort: stringOrNull(draft.reasoningEffort),
    temperature: numberOrNull(draft.temperature),
    maxContextTokens: numberOrNull(draft.maxContextTokens),
    numCtx: numberOrNull(draft.numCtx),
    webSearchProvider: stringOrNull(draft.webSearchProvider),
    memoryScopes: commaList(draft.memoryScopes),
    envAllowlist: commaList(draft.envAllowlist),
    tools: draft.tools,
    deniedTools: draft.deniedTools,
    companions: draft.companions,
  };
}

/**
 * Whether a tool is actually available to this agent.
 *
 * Three fields decide one checkbox, because `tools` can only add and `deniedTools` can only
 * take away. A tool is on when something granted it and nothing denied it — a denial wins,
 * matching how jazz resolves the same contradiction.
 */
function toolIsOn(tool: string, draft: Draft, defaults: readonly string[]): boolean {
  if (draft.deniedTools.includes(tool)) return false;
  return defaults.includes(tool) || draft.tools.includes(tool);
}

/**
 * Flip one tool, writing to whichever field actually controls it.
 *
 * Switching off a tool that arrives by default means denying it: taking it out of `tools`
 * would do nothing, because the built-in bundle grants it regardless. Switching off one the
 * agent asked for just withdraws the request. Getting this backwards is the difference
 * between a checkbox that works and one that only looks like it did.
 */
function toggleTool(tool: string, draft: Draft, defaults: readonly string[]): Draft {
  const isDefault = defaults.includes(tool);
  if (toolIsOn(tool, draft, defaults)) {
    return {
      ...draft,
      tools: draft.tools.filter((name) => name !== tool),
      deniedTools: isDefault ? [...draft.deniedTools, tool] : draft.deniedTools,
    };
  }
  return {
    ...draft,
    deniedTools: draft.deniedTools.filter((name) => name !== tool),
    tools: isDefault || draft.tools.includes(tool) ? draft.tools : [...draft.tools, tool],
  };
}

function problemText(problem: BridgeState["jazzProblem"]): string {
  switch (problem) {
    case "unreachable":
      return "jazz is not answering. Start it with `jazz daemon`.";
    case "unauthorized":
      return "jazz refused quartet's token. Re-run `quartet connect`.";
    case "unsupported":
      return "This jazz is too old to manage agents from here. Update it.";
    default:
      return "jazz could not be asked which agents it has.";
  }
}

export function Dashboard({
  state,
  onClose,
  onAct,
}: {
  state: BridgeState;
  onClose: () => void;
  onAct: (path: string, body: Record<string, unknown>) => Promise<void>;
}): ReactElement {
  const [openId, setOpenId] = useState<string | undefined>(state.myAgentId);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [detail, setDetail] = useState<JazzAgentDetail | undefined>(undefined);
  const [personas, setPersonas] = useState<JazzPersona[]>([]);
  const [tools, setTools] = useState<JazzTools | undefined>(undefined);
  const [models, setModels] = useState<JazzModel[] | undefined>(undefined);
  const [modelsProblem, setModelsProblem] = useState<string | undefined>(undefined);
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const catalog = state.jazzCatalog;
  const editable = catalog !== undefined;

  // The catalogues that cannot change while a form is open, asked for once.
  useEffect(() => {
    if (!editable) return;
    void read<JazzPersona[]>("agents/personas").then((result) => {
      if ("value" in result) setPersonas(result.value);
    });
    void read<JazzTools>("agents/tools").then((result) => {
      if ("value" in result) setTools(result.value);
    });
  }, [editable]);

  // One agent in full. The roster carries only what a list needs.
  useEffect(() => {
    if (creating || openId === undefined) return;
    setRefusal(undefined);
    void read<JazzAgentDetail>("agents/detail", { id: openId }).then((result) => {
      if ("value" in result) {
        setDetail(result.value);
        setDraft(draftFrom(result.value));
      } else {
        setRefusal(result.refused);
      }
    });
  }, [openId, creating]);

  // Models are a live fetch per provider, so this is the one menu that can be slow or fail.
  useEffect(() => {
    if (draft.llmProvider.length === 0) {
      setModels(undefined);
      return;
    }
    let current = true;
    setModels(undefined);
    setModelsProblem(undefined);
    void read<JazzModel[]>("agents/models", { provider: draft.llmProvider }).then((result) => {
      if (!current) return;
      if ("value" in result) setModels(result.value);
      else setModelsProblem(result.refused.error);
    });
    return () => {
      current = false;
    };
  }, [draft.llmProvider]);

  const chosenModel = models?.find((model) => model.id === draft.llmModel);
  const defaults = tools?.defaultTools ?? [];
  const onStage = detail !== undefined && detail.id === state.myAgentId;
  // Switching agents discards an unfinished edit, so the button says there is one to lose.
  const dirty =
    creating || (detail !== undefined && JSON.stringify(draft) !== JSON.stringify(draftFrom(detail)));

  const fieldError = (field: string): string | undefined =>
    refusal?.field === field ? refusal.error : undefined;

  function fieldNote(field: string): ReactElement | null {
    const message = fieldError(field);
    return message === undefined ? null : <p className="dash-wrong">{message}</p>;
  }

  async function save(): Promise<void> {
    setBusy(true);
    setRefusal(undefined);
    const config = configFrom(draft);
    const result = creating
      ? await read<JazzAgentDetail>("agents/create", {
          name: draft.name.trim(),
          description: draft.description.trim(),
          config,
        })
      : await read<JazzAgentDetail>("agents/update", {
          id: openId ?? "",
          name: draft.name.trim(),
          description: draft.description,
          config,
        });
    setBusy(false);

    if ("refused" in result) {
      setRefusal(result.refused);
      return;
    }
    setDetail(result.value);
    setDraft(draftFrom(result.value));
    setCreating(false);
    setOpenId(result.value.id);
  }

  function startCreating(): void {
    setCreating(true);
    setDetail(undefined);
    setRefusal(undefined);
    setDraft({ ...BLANK, llmProvider: catalog?.providers[0] ?? "" });
  }

  return (
    <section className="dash">
      <div className="dash-top">
        <span className="pane-title">Your agents</span>
        <div className="spacer" />
        <button className="btn" type="button" onClick={onClose}>
          Back to rooms
        </button>
      </div>

      {state.jazzProblem !== undefined && (
        <div className="error dash-banner">{problemText(state.jazzProblem)}</div>
      )}
      {state.jazzProblem === undefined && !editable && (
        <div className="error dash-banner">
          This jazz can list agents but not change them. Update jazz to create and edit them
          from here.
        </div>
      )}

      <div className="dash-body">
        <div className="dash-roster pane-scroll">
          {state.jazzAgents.length === 0 && (
            <div className="empty">
              No agents on this machine yet.{" "}
              {editable ? "Make one to get started." : "Create one with `jazz agent create`."}
            </div>
          )}
          {state.jazzAgents.map((agent) => {
            const live = agent.id === state.myAgentId;
            const open = agent.id === openId && !creating;
            return (
              <button
                key={agent.id}
                type="button"
                className={`dash-row${live ? " live" : ""}${open ? " open" : ""}`}
                onClick={() => {
                  setCreating(false);
                  setOpenId(agent.id);
                }}
              >
                <span className={live ? "monogram on" : "monogram"}>
                  {agent.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="row-main">
                  <span className="dash-row-title">
                    {agent.name}
                    {live && <span className="dash-onstage">on stage</span>}
                  </span>
                  <span className="row-sub">
                    {agent.provider !== undefined && agent.model !== undefined
                      ? `${agent.provider}/${agent.model}`
                      : "model not recorded"}
                  </span>
                </span>
              </button>
            );
          })}
          {editable && (
            <button className="btn dash-new" type="button" onClick={startCreating}>
              New agent
            </button>
          )}
        </div>

        <div className="dash-editor pane-scroll">
          {openId === undefined && !creating && (
            <div className="placeholder">Pick an agent, or make one.</div>
          )}

          {(creating || detail !== undefined) && (
            <>
              {detail !== undefined && !onStage && (
                <button
                  className="btn go dash-promote"
                  type="button"
                  disabled={busy}
                  onClick={() => void onAct("agents/select", { agentId: detail.id })}
                >
                  Let {detail.name} speak for you
                </button>
              )}

              <div className="dash-group">Who it is</div>
              <label className="dash-label" htmlFor="agent-name">
                Name
              </label>
              <input
                id="agent-name"
                className={fieldError("name") !== undefined ? "field wrong" : "field"}
                value={draft.name}
                disabled={!editable}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              {fieldNote("name")}

              <label className="dash-label" htmlFor="agent-description">
                Description
              </label>
              <input
                id="agent-description"
                className="field"
                value={draft.description}
                disabled={!editable}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
              {fieldNote("description")}

              <label className="dash-label" htmlFor="agent-persona">
                Persona
              </label>
              <select
                id="agent-persona"
                className="field"
                value={draft.persona}
                disabled={!editable}
                onChange={(event) => setDraft({ ...draft, persona: event.target.value })}
              >
                {personas.length === 0 && <option value={draft.persona}>{draft.persona}</option>}
                {personas.map((persona) => (
                  <option key={persona.id} value={persona.name}>
                    {persona.name}
                    {persona.description.length > 0 ? ` — ${persona.description}` : ""}
                  </option>
                ))}
              </select>
              {fieldNote("config.persona")}

              <div className="dash-group">What it thinks with</div>
              <label className="dash-label" htmlFor="agent-provider">
                Provider
              </label>
              <select
                id="agent-provider"
                className="field"
                value={draft.llmProvider}
                disabled={!editable}
                onChange={(event) =>
                  setDraft({ ...draft, llmProvider: event.target.value, llmModel: "" })
                }
              >
                <option value="">pick one</option>
                {(catalog?.providers ?? []).map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}
                  </option>
                ))}
              </select>
              {fieldNote("config.llmProvider")}

              <label className="dash-label" htmlFor="agent-model">
                Model
              </label>
              {modelsProblem !== undefined ? (
                <>
                  {/* The catalogue is unavailable, not the model, so naming one still works. */}
                  <input
                    id="agent-model"
                    className="field"
                    placeholder="name the model"
                    value={draft.llmModel}
                    onChange={(event) => setDraft({ ...draft, llmModel: event.target.value })}
                  />
                  <p className="dash-hint">{modelsProblem}</p>
                </>
              ) : (
                <select
                  id="agent-model"
                  className="field"
                  value={draft.llmModel}
                  disabled={!editable || models === undefined}
                  onChange={(event) => setDraft({ ...draft, llmModel: event.target.value })}
                >
                  <option value="">
                    {draft.llmProvider.length === 0
                      ? "pick a provider first"
                      : models === undefined
                        ? "asking jazz…"
                        : "pick one"}
                  </option>
                  {(models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName ?? model.id}
                      {model.isReasoningModel ? " · reasoning" : ""}
                    </option>
                  ))}
                </select>
              )}
              {fieldNote("config.llmModel")}

              {chosenModel?.isReasoningModel === true && (
                <>
                  <label className="dash-label" htmlFor="agent-effort">
                    Reasoning effort
                  </label>
                  <select
                    id="agent-effort"
                    className="field"
                    value={draft.reasoningEffort}
                    onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value })}
                  >
                    <option value="">provider default</option>
                    {(catalog?.reasoningEfforts ?? []).map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                  {fieldNote("config.reasoningEffort")}
                </>
              )}

              {/* Absent rather than inert when the model ignores it: a control that silently
                  does nothing is worse than no control, because it looks like a setting. */}
              {chosenModel !== undefined &&
                (chosenModel.supportsTemperature ? (
                  <>
                    <label className="dash-label" htmlFor="agent-temperature">
                      Temperature
                    </label>
                    <input
                      id="agent-temperature"
                      className={
                        fieldError("config.temperature") !== undefined ? "field wrong" : "field"
                      }
                      inputMode="decimal"
                      placeholder="provider default"
                      value={draft.temperature}
                      onChange={(event) => setDraft({ ...draft, temperature: event.target.value })}
                    />
                    {fieldNote("config.temperature")}
                  </>
                ) : (
                  <p className="dash-hint">
                    {chosenModel.id} ignores temperature, so there is nothing to set.
                  </p>
                ))}

              <label className="dash-label" htmlFor="agent-summarizer">
                Summarizer model
              </label>
              <input
                id="agent-summarizer"
                className="field"
                placeholder="provider/model — defaults to its own"
                value={draft.summarizerModel}
                disabled={!editable}
                onChange={(event) => setDraft({ ...draft, summarizerModel: event.target.value })}
              />
              {fieldNote("config.summarizerModel")}

              <ToolPicker
                tools={tools}
                defaults={defaults}
                draft={draft}
                editable={editable}
                onToggle={(tool) => setDraft(toggleTool(tool, draft, defaults))}
              />

              <div className="dash-group">What it delegates to</div>
              <p className="dash-hint">
                A model bound here handles media this agent's own model cannot read. Quartet
                drives jazz unattended, so an unbound modality does not stop to ask you — it
                fails the turn instead.
              </p>
              {(catalog?.perceptionCapabilities ?? []).map((capability) => (
                <CompanionRow
                  key={capability}
                  capability={capability}
                  providers={catalog?.providers ?? []}
                  bound={draft.companions[capability] ?? ""}
                  editable={editable}
                  onBind={(value) => {
                    const next = { ...draft.companions };
                    if (value.length === 0) delete next[capability];
                    else next[capability] = value;
                    setDraft({ ...draft, companions: next });
                  }}
                />
              ))}
              {fieldNote("config.companions")}
              {(catalog?.perceptionCapabilities ?? []).map((capability) =>
                fieldNote(`config.companions.${capability}`),
              )}

              <div className="dash-group">What it keeps</div>
              <label className="dash-label" htmlFor="agent-context">
                Context ceiling, in tokens
              </label>
              <input
                id="agent-context"
                className="field"
                inputMode="numeric"
                placeholder="the model's own window"
                value={draft.maxContextTokens}
                disabled={!editable}
                onChange={(event) => setDraft({ ...draft, maxContextTokens: event.target.value })}
              />
              {fieldNote("config.maxContextTokens")}

              {draft.llmProvider === "ollama" && (
                <>
                  <label className="dash-label" htmlFor="agent-numctx">
                    Ollama num_ctx
                  </label>
                  <input
                    id="agent-numctx"
                    className="field"
                    inputMode="numeric"
                    value={draft.numCtx}
                    onChange={(event) => setDraft({ ...draft, numCtx: event.target.value })}
                  />
                  {fieldNote("config.numCtx")}
                </>
              )}

              <label className="dash-label" htmlFor="agent-memory">
                Memory scopes
              </label>
              <input
                id="agent-memory"
                className="field"
                placeholder="work, personal"
                value={draft.memoryScopes}
                disabled={!editable}
                onChange={(event) => setDraft({ ...draft, memoryScopes: event.target.value })}
              />
              {fieldNote("config.memoryScopes")}

              <label className="dash-label" htmlFor="agent-env">
                Env vars it may keep
              </label>
              <input
                id="agent-env"
                className="field"
                placeholder="MY_TOKEN, OTHER_VAR"
                value={draft.envAllowlist}
                disabled={!editable}
                onChange={(event) => setDraft({ ...draft, envAllowlist: event.target.value })}
              />
              {fieldNote("config.envAllowlist")}

              <label className="dash-label" htmlFor="agent-websearch">
                Web search
              </label>
              <select
                id="agent-websearch"
                className="field"
                value={draft.webSearchProvider}
                disabled={!editable}
                onChange={(event) => setDraft({ ...draft, webSearchProvider: event.target.value })}
              >
                <option value="">none</option>
                {(catalog?.webSearchProviders ?? []).map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}
                  </option>
                ))}
              </select>
              {fieldNote("config.webSearchProvider")}

              {detail !== undefined && detail.apiKeyProviders.length > 0 && (
                <p className="dash-hint">
                  A per-agent API key is set for {detail.apiKeyProviders.join(", ")}. Keys are
                  never shown here — change one with `jazz agent edit`, which puts it in the
                  keyring.
                </p>
              )}

              {refusal !== undefined && refusal.field === undefined && (
                <p className="dash-wrong">
                  {refusal.error}
                  {refusal.suggestion !== undefined && ` ${refusal.suggestion}`}
                </p>
              )}

              {editable && (
                <div className="dash-actions">
                  <button
                    className="btn go"
                    type="button"
                    disabled={busy || !dirty}
                    onClick={() => void save()}
                  >
                    {creating ? "Create agent" : dirty ? "Save changes" : "Saved"}
                  </button>
                  {/* Absent rather than disabled on the agent that speaks for you: a greyed
                      control never says why, and the reason is the actionable part. */}
                  {detail !== undefined && !onStage ? (
                    <button
                      className="btn stop"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void onAct("agents/delete", { id: detail.id }).then(() => {
                          setOpenId(undefined);
                          setDetail(undefined);
                        });
                      }}
                    >
                      Delete
                    </button>
                  ) : (
                    detail !== undefined && (
                      <span className="dash-hint dash-inline">
                        Switch to another agent before deleting this one.
                      </span>
                    )
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Which tools this agent can reach, and which of those are a choice.
 *
 * A default tool and an added one look identical in a flat list and behave nothing alike, so
 * every row is tagged. Without that, a checkbox beside a bundled tool would imply a
 * permission it does not hold — unticking it would change nothing, because the bundle grants
 * it regardless.
 */
function ToolPicker({
  tools,
  defaults,
  draft,
  editable,
  onToggle,
}: {
  tools: JazzTools | undefined;
  defaults: readonly string[];
  draft: Draft;
  editable: boolean;
  onToggle: (tool: string) => void;
}): ReactElement | null {
  if (tools === undefined) return null;

  const categorised = new Set(Object.values(tools.categories).flat());
  const groups = Object.entries(tools.categories);
  const loose = tools.tools.filter((tool) => !categorised.has(tool));
  if (loose.length > 0) groups.push(["other", loose]);

  return (
    <>
      <div className="dash-group">What it can reach</div>
      <p className="dash-hint">
        Unchecking a default tool denies it to this agent alone. Everything else is an extra it
        only gets if you ask.
      </p>
      {groups.map(([category, names]) => (
        <div className="dash-tools" key={category}>
          <div className="dash-tool-cat">{category}</div>
          {names.map((tool) => {
            const on = toolIsOn(tool, draft, defaults);
            const denied = draft.deniedTools.includes(tool);
            return (
              <label className={on ? "dash-tool" : "dash-tool off"} key={tool}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!editable}
                  onChange={() => onToggle(tool)}
                />
                <span className="dash-tool-name">{tool}</span>
                <span className={denied ? "dash-tool-tag denied" : "dash-tool-tag"}>
                  {denied ? "denied" : defaults.includes(tool) ? "default" : "extra"}
                </span>
              </label>
            );
          })}
        </div>
      ))}
    </>
  );
}

/**
 * One modality's companion: a provider, then a model that can actually take that modality.
 *
 * The model list is asked for with the capability attached, so jazz does the filtering and
 * the ordering — priced before unpriced, then cheapest. Deciding either here would disagree
 * with what jazz's own picker recommends for the same question.
 *
 * A provider legitimately has none: Anthropic serves eleven vision models and no audio ones.
 * That is an answer, so it is stated rather than left as an empty menu.
 */
function CompanionRow({
  capability,
  providers,
  bound,
  editable,
  onBind,
}: {
  capability: string;
  providers: readonly string[];
  bound: string;
  editable: boolean;
  onBind: (value: string) => void;
}): ReactElement {
  const [boundProvider, boundModel] = bound.split("/", 2);
  const [provider, setProvider] = useState(boundProvider ?? "");
  const [models, setModels] = useState<JazzModel[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (provider.length === 0) {
      setModels(undefined);
      return;
    }
    let current = true;
    setModels(undefined);
    setProblem(undefined);
    void read<JazzModel[]>("agents/models", { provider, capability }).then((result) => {
      if (!current) return;
      if ("value" in result) setModels(result.value);
      else setProblem(result.refused.error);
    });
    return () => {
      current = false;
    };
  }, [provider, capability]);

  return (
    <div className="dash-companion">
      <span className="dash-companion-name">{capability}</span>
      <select
        className="field"
        aria-label={`${capability} companion provider`}
        value={provider}
        disabled={!editable}
        onChange={(event) => {
          setProvider(event.target.value);
          // Clearing the provider unbinds: a provider with no model chosen is not a binding.
          onBind("");
        }}
      >
        <option value="">none</option>
        {providers.map((candidate) => (
          <option key={candidate} value={candidate}>
            {candidate}
          </option>
        ))}
      </select>
      <select
        className="field"
        aria-label={`${capability} companion model`}
        value={boundModel ?? ""}
        disabled={!editable || provider.length === 0 || models === undefined || models.length === 0}
        onChange={(event) =>
          onBind(event.target.value.length === 0 ? "" : `${provider}/${event.target.value}`)
        }
      >
        <option value="">
          {provider.length === 0
            ? "no provider"
            : problem !== undefined
              ? "could not ask jazz"
              : models === undefined
                ? "asking jazz…"
                : models.length === 0
                  ? `${provider} has none`
                  : "pick one"}
        </option>
        {(models ?? []).map((model) => (
          <option key={model.id} value={model.id}>
            {model.displayName ?? model.id}
          </option>
        ))}
      </select>
    </div>
  );
}
