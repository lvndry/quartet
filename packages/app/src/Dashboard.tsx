/**
 * @fileoverview Your agents, as a roster.
 *
 * Not a settings page: exactly one of these is on stage, and "which agent is answering" is
 * what somebody opens this screen to check.
 *
 * Every menu is served by jazz rather than typed out here, so a picker structurally cannot
 * offer something a save would reject. The form does not re-implement jazz's rules either: it
 * posts, and a refusal comes back naming the field to mark.
 */

import { useEffect, useState, type ReactElement } from "react";
import { Devices } from "./Devices";
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
 * The config patch for a draft, against what is stored for that agent.
 *
 * Empty means two different things depending on what was there before, and conflating them
 * is why a freshly created agent's file used to carry fourteen keys where `jazz agent create`
 * writes three:
 *
 * - a field that was never set is **left out**, so the file stays as small as the CLI's
 * - a field that *was* set and has been cleared is sent **empty** — `null` for a scalar,
 *   `[]`/`{}` for a list — because a shallow merge cannot remove a key. jazz's validation
 *   skips null and its runtime only reads these when they are the right type, so null is how
 *   "no longer set" survives a PATCH.
 */
function configFrom(draft: Draft, stored: Record<string, unknown> = {}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    persona: draft.persona,
    llmProvider: draft.llmProvider,
    llmModel: draft.llmModel.trim(),
  };

  /** Whether the stored config carried a value worth clearing. */
  const wasSet = (key: string): boolean => {
    const value = stored[key];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  };

  const text = (key: string, raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length > 0) config[key] = trimmed;
    else if (wasSet(key)) config[key] = null;
  };

  const number = (key: string, raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      if (wasSet(key)) config[key] = null;
      return;
    }
    const parsed = Number(trimmed);
    // A value that is not a number goes over as typed so jazz refuses it and names the
    // field, rather than being silently dropped or turned into null here.
    config[key] = Number.isFinite(parsed) ? parsed : trimmed;
  };

  const list = (key: string, values: readonly string[]): void => {
    if (values.length > 0) config[key] = values;
    else if (wasSet(key)) config[key] = [];
  };

  text("summarizerModel", draft.summarizerModel);
  text("reasoningEffort", draft.reasoningEffort);
  text("webSearchProvider", draft.webSearchProvider);
  number("temperature", draft.temperature);
  number("maxContextTokens", draft.maxContextTokens);
  number("numCtx", draft.numCtx);
  list("memoryScopes", commaList(draft.memoryScopes));
  list("envAllowlist", commaList(draft.envAllowlist));
  list("tools", draft.tools);
  list("deniedTools", draft.deniedTools);

  if (Object.keys(draft.companions).length > 0) config["companions"] = draft.companions;
  else if (wasSet("companions")) config["companions"] = {};

  return config;
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

/**
 * The roles jazz serves, gathered by their action half.
 *
 * Split on the key rather than listing the actions here: a role is `"<action>:<modality>"`,
 * so jazz adding a third action should show up without this file being edited. Order follows
 * jazz's own, which puts analysis — the half that has a consumer — first.
 */
function byAction(roles: readonly string[]): [string, string[]][] {
  const grouped: [string, string[]][] = [];
  for (const role of roles) {
    const [action, modality] = role.split(":", 2);
    if (action === undefined || modality === undefined) continue;
    const existing = grouped.find(([name]) => name === action);
    if (existing === undefined) grouped.push([action, [role]]);
    else existing[1].push(role);
  }
  return grouped;
}

/**
 * A persona being written here.
 *
 * Matches the file it becomes — `~/.jazz/personas/<name>/persona.md`, frontmatter then body —
 * rather than inventing a shape of quartet's own. Anything written here is an ordinary jazz
 * persona: `jazz persona list` sees it, and agents that never touch quartet can use it.
 */
interface PersonaDraft {
  name: string;
  description: string;
  tone: string;
  style: string;
  systemPrompt: string;
}

const BLANK_PERSONA: PersonaDraft = {
  name: "",
  description: "",
  tone: "",
  style: "",
  systemPrompt: "",
};

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
  const [showEverything, setShowEverything] = useState(false);
  const [personaDraft, setPersonaDraft] = useState<PersonaDraft | undefined>(undefined);
  const [personaRefusal, setPersonaRefusal] = useState<Refusal | undefined>(undefined);
  // An old jazz serves the persona list and not the writes. The first attempt is the probe:
  // once it has answered "no route here", the offer stops being made.
  const [personaWritesGone, setPersonaWritesGone] = useState(false);

  const catalog = state.jazzCatalog;
  const editable = catalog !== undefined;
  const noAgentsYet = state.jazzAgents.length === 0;
  /**
   * Fourteen fields is the right form for editing an agent and the wrong one for meeting
   * quartet. Only the very first agent gets the short version — everything past the model is
   * behind a disclosure — because only then is there nothing else on screen to learn from.
   */
  const folded = creating && noAgentsYet && !showEverything;

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
    // Read before the await: creating the agent is what makes this false.
    const isTheFirst = creating && noAgentsYet;
    const config = configFrom(draft, detail?.config);
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

    // The first agent goes on stage without being asked. There is nothing to choose between,
    // and leaving somebody who has just made their only agent looking at a button called
    // "let it speak for you" is the same dead end one screen further on.
    if (isTheFirst) await onAct("agents/select", { agentId: result.value.id });
  }

  async function savePersona(): Promise<void> {
    if (personaDraft === undefined) return;
    setBusy(true);
    setPersonaRefusal(undefined);
    const result = await read<JazzPersona>("agents/personas/create", {
      name: personaDraft.name.trim(),
      description: personaDraft.description.trim(),
      systemPrompt: personaDraft.systemPrompt.trim(),
      tone: personaDraft.tone.trim(),
      style: personaDraft.style.trim(),
    });
    setBusy(false);

    if ("refused" in result) {
      setPersonaRefusal(result.refused);
      if (result.refused.reason === "unsupported") setPersonaWritesGone(true);
      return;
    }
    // Straight onto the agent being edited: writing a persona from this form is something
    // somebody does because they want *this* agent to use it.
    setPersonas((known) => [...known, result.value]);
    setDraft({ ...draft, persona: result.value.name });
    setPersonaDraft(undefined);
  }

  function startCreating(): void {
    setCreating(true);
    setShowEverything(false);
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
          {/* On a first run this is the whole screen, not a footnote above an empty list:
              there is no agent, so there is nothing else here to do. */}
          {noAgentsYet && !creating && (
            <div className="dash-firstrun">
              <h2>Nobody is on stage</h2>
              {editable ? (
                <>
                  <p>
                    You have a handle and a key, but no agent to answer with. Make one and it
                    starts taking turns — you will not need the terminal again.
                  </p>
                  <button className="btn go" type="button" onClick={startCreating}>
                    Make my first agent
                  </button>
                </>
              ) : (
                <p>
                  This jazz can list agents but not create them. Update jazz to do it here, or
                  run <code>jazz agent create</code> and reload.
                </p>
              )}
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
          {editable && !noAgentsYet && (
            <button className="btn dash-new" type="button" onClick={startCreating}>
              New agent
            </button>
          )}

          <Devices />
        </div>

        <div className="dash-editor pane-scroll">
          {openId === undefined && !creating && (
            <div className="placeholder">
              {noAgentsYet ? "Nothing to show until there is an agent." : "Pick an agent, or make one."}
            </div>
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

              {!folded && (
                <>
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
                </>
              )}

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

              {/* A menu with nothing suitable in it is a dead end, and the way out was a
                  command in another terminal. */}
              {editable && !personaWritesGone && personaDraft === undefined && (
                <button
                  className="linky dash-write-persona"
                  type="button"
                  onClick={() => {
                    setPersonaRefusal(undefined);
                    setPersonaDraft(BLANK_PERSONA);
                  }}
                >
                  Write a new persona
                </button>
              )}

              {personaWritesGone && (
                <p className="dash-hint">
                  This jazz can list personas but not write them. Make one with{" "}
                  <code>jazz persona create</code> and reload, or update jazz to do it here.
                </p>
              )}

              {personaDraft !== undefined && (
                <PersonaForm
                  draft={personaDraft}
                  refusal={personaRefusal}
                  busy={busy}
                  onChange={setPersonaDraft}
                  onCancel={() => {
                    setPersonaDraft(undefined);
                    setPersonaRefusal(undefined);
                  }}
                  onSave={() => void savePersona()}
                />
              )}

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

              {!folded && (
                <>
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
                {byAction(catalog?.companionRoles ?? []).map(([action, roles]) => (
                  <div className="dash-delegation" key={action}>
                    <div className="dash-action">{action}</div>
                    <p className="dash-hint">
                      {action === "generate"
                        ? "Nothing delegates generation yet, so a model bound here is recorded and unused until something does."
                        : "Media this agent's own model cannot read. Quartet drives jazz unattended, so an unbound modality does not stop to ask you — it fails the turn instead."}
                    </p>
                    {roles.map((role) => (
                      <CompanionRow
                        key={role}
                        role={role}
                        providers={catalog?.providers ?? []}
                        bound={draft.companions[role] ?? ""}
                        editable={editable}
                        onBind={(value) => {
                          const next = { ...draft.companions };
                          if (value.length === 0) delete next[role];
                          else next[role] = value;
                          setDraft({ ...draft, companions: next });
                        }}
                      />
                    ))}
                  </div>
                ))}
                {fieldNote("config.companions")}
                {(catalog?.companionRoles ?? []).map((role) => fieldNote(`config.companions.${role}`))}

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
                </>
              )}

              {folded && (
                <button
                  className="btn dash-more"
                  type="button"
                  onClick={() => setShowEverything(true)}
                >
                  Everything else
                </button>
              )}

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
                    {creating
                      ? noAgentsYet
                        ? "Create and put on stage"
                        : "Create agent"
                      : dirty
                        ? "Save changes"
                        : "Saved"}
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
 * Writing a persona, inline under the field that needed one.
 *
 * Not a screen of its own: the reason somebody is here is that the menu above had nothing
 * suitable in it, and taking them away from the agent they were configuring to fix that would
 * lose the half-filled form that prompted it.
 */
function PersonaForm({
  draft,
  refusal,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: PersonaDraft;
  refusal: Refusal | undefined;
  busy: boolean;
  onChange: (next: PersonaDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}): ReactElement {
  const wrong = (field: string): string | undefined =>
    refusal?.field === field ? refusal.error : undefined;

  return (
    <div className="dash-persona">
      <div className="dash-group">A new persona</div>

      <label className="dash-label" htmlFor="persona-name">
        Name
      </label>
      <input
        id="persona-name"
        className={wrong("name") !== undefined ? "field wrong" : "field"}
        placeholder="sceptic"
        value={draft.name}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
      />

      <label className="dash-label" htmlFor="persona-description">
        Description
      </label>
      <input
        id="persona-description"
        className="field"
        placeholder="Asks what would have to be true"
        value={draft.description}
        onChange={(event) => onChange({ ...draft, description: event.target.value })}
      />

      <div className="dash-persona-pair">
        <div>
          <label className="dash-label" htmlFor="persona-tone">
            Tone
          </label>
          <input
            id="persona-tone"
            className="field"
            placeholder="optional"
            value={draft.tone}
            onChange={(event) => onChange({ ...draft, tone: event.target.value })}
          />
        </div>
        <div>
          <label className="dash-label" htmlFor="persona-style">
            Style
          </label>
          <input
            id="persona-style"
            className="field"
            placeholder="optional"
            value={draft.style}
            onChange={(event) => onChange({ ...draft, style: event.target.value })}
          />
        </div>
      </div>

      <label className="dash-label" htmlFor="persona-prompt">
        System prompt
      </label>
      <textarea
        id="persona-prompt"
        className={wrong("systemPrompt") !== undefined ? "field wrong" : "field"}
        rows={6}
        placeholder="How this persona approaches a conversation."
        value={draft.systemPrompt}
        onChange={(event) => onChange({ ...draft, systemPrompt: event.target.value })}
      />
      <p className="dash-hint">
        Saved to ~/.jazz/personas/{draft.name.trim().length > 0 ? draft.name.trim() : "<name>"}
        /persona.md, so every agent on this machine can use it.
      </p>

      {refusal !== undefined && refusal.field === undefined && (
        <p className="dash-wrong">
          {refusal.error}
          {refusal.suggestion !== undefined && ` ${refusal.suggestion}`}
        </p>
      )}

      <div className="dash-actions">
        <button
          className="btn go"
          type="button"
          disabled={busy || draft.name.trim().length === 0 || draft.systemPrompt.trim().length === 0}
          onClick={onSave}
        >
          Save persona
        </button>
        <button className="btn" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * One role's companion: a provider, then a model that can actually do that job.
 *
 * The model list is asked for with the role attached, so jazz does the filtering and the
 * ordering — priced before unpriced, then cheapest. Deciding either here would disagree with
 * what jazz's own picker recommends for the same question.
 *
 * A provider legitimately has none: Anthropic serves eleven models that read an image and
 * none that listen. That is an answer, so it is stated rather than left as an empty menu.
 */
function CompanionRow({
  role,
  providers,
  bound,
  editable,
  onBind,
}: {
  role: string;
  providers: readonly string[];
  bound: string;
  editable: boolean;
  onBind: (value: string) => void;
}): ReactElement {
  // The action is the group heading, so the row only has to name the modality.
  const modality = role.split(":", 2)[1] ?? role;
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
    void read<JazzModel[]>("agents/models", { provider, role }).then((result) => {
      if (!current) return;
      if ("value" in result) setModels(result.value);
      else setProblem(result.refused.error);
    });
    return () => {
      current = false;
    };
  }, [provider, role]);

  return (
    <div className="dash-companion">
      <span className="dash-companion-name">{modality}</span>
      <select
        className="field"
        aria-label={`${role} companion provider`}
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
        aria-label={`${role} companion model`}
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
