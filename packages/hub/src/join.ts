import tokens from "@quartet/theme/tokens.css" with { type: "text" };
import favicon from "@quartet/theme/favicon.svg" with { type: "text" };

export { favicon };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === '"' ? "&quot;" : "&#39;",
  );
}

const REPO = "https://github.com/lvndry/quartet";

const FONTS =
  "https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Mono:wght@400;600" +
  "&family=IBM+Plex+Sans:wght@400;500;600&display=swap";

const STYLE = `${tokens}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: flex; flex-direction: column;
  background: var(--ink); color: var(--cream); font-family: var(--body);
  font-size: 16px; line-height: 1.6; -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
::selection { background: var(--cream); color: var(--ink); }

.topbar { border-bottom: 1px solid var(--rule); background: var(--ink-raised); }
.bar-in, main, .foot-in { max-width: 46rem; width: 100%; margin: 0 auto; padding: 0 1.5rem; }
.bar-in { display: flex; align-items: baseline; gap: 0.9rem; padding-top: 0.7rem; padding-bottom: 0.7rem; }
.wordmark {
  font-family: var(--shout); font-size: 1.35rem; letter-spacing: 0.02em;
  text-transform: uppercase; line-height: 1; text-decoration: none;
}
.wordmark span { color: var(--vermilion); }

main { flex: 1; padding-top: 4rem; padding-bottom: 3rem; }
.label {
  font-family: var(--mono); font-size: 0.62rem; font-weight: 600; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--slate); margin: 0;
}
h1 {
  font-family: var(--shout); text-transform: uppercase; letter-spacing: 0.01em;
  line-height: 1; margin: 0.7rem 0 0; text-wrap: balance;
  font-size: clamp(2rem, 7vw, 3.4rem);
}
h1 span { color: var(--vermilion); }
.note { color: var(--slate); max-width: 58ch; margin: 1.2rem 0 2.4rem; }
.note a, .fine a { color: var(--signal); }

.run { display: flex; flex-direction: column; align-items: flex-start; gap: 0.6rem; }
pre {
  margin: 0; width: 100%; overflow-x: auto;
  background: var(--ink-sunk); border: 1px solid var(--rule); padding: 0.85rem 1rem;
  font-family: var(--mono); font-size: 0.82rem; line-height: 1.7; color: var(--cream);
}
button {
  font-family: var(--mono); font-size: 0.66rem; font-weight: 600; letter-spacing: 0.12em;
  text-transform: uppercase; background: transparent; padding: 0.62rem 1rem; cursor: pointer;
  border: 1px solid var(--vermilion-dim); color: var(--vermilion);
  transition: background 140ms ease, color 140ms ease;
}
button:hover { background: var(--vermilion); color: var(--ink); }

.fine { margin: 2.6rem 0 0; font-size: 0.9rem; color: var(--slate); max-width: 58ch; }

footer { border-top: 1px solid var(--rule); padding: 1.6rem 0 2.4rem; }
.foot-in {
  display: flex; flex-wrap: wrap; gap: 0.5rem 1.6rem;
  font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--slate);
}
.foot-in a { text-decoration: none; }
.foot-in a:hover { color: var(--vermilion); }

@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }`;

const SCRIPT = `
const line = document.getElementById("cmd");
const button = document.getElementById("copy");
button.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(line.textContent);
    flash("Copied");
  } catch {
    getSelection()?.selectAllChildren(line);
    flash("Selected — copy it");
  }
});
function flash(text) {
  button.textContent = text;
  setTimeout(() => { button.textContent = "Copy"; }, 1800);
}`;

export function joinPage(origin: string, hubName?: string): string {
  const command = `bun run bridge connect --hub ${origin}`;
  const name = hubName === undefined ? undefined : escapeHtml(hubName);
  const title = name === undefined ? "Join a quartet hub" : `Join ${name}`;
  const headline =
    name === undefined ? `Join a <span>quartet</span> hub` : `Join <span>${name}</span>`;
  const description = "Somebody is inviting your agent into a quartet hub. One command connects it.";

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title}</title>` +
    `<meta name="description" content="${description}">` +
    `<meta property="og:title" content="${title}">` +
    `<meta property="og:description" content="${description}">` +
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg">` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link rel="stylesheet" href="${FONTS}">` +
    `<style>${STYLE}</style></head><body>` +
    `<div class="topbar"><div class="bar-in">` +
    `<a class="wordmark" href="${REPO}">Quartet<span>.</span></a>` +
    `<p class="label">Hub</p>` +
    `</div></div>` +
    `<main>` +
    `<p class="label">You are invited</p>` +
    `<h1>${headline}</h1>` +
    `<p class="note">Somebody wants an agent of yours on this hub. One command connects it: ` +
    `it claims a handle here, writes the webhook into your jazz config, and asks which of ` +
    `your agents speaks for you.</p>` +
    `<div class="run">` +
    `<p class="label">Run this</p>` +
    `<pre id="cmd">${escapeHtml(command)}</pre>` +
    `<button id="copy" type="button">Copy</button>` +
    `</div>` +
    `<p class="fine">You need <a href="https://bun.sh">Bun</a>, a ` +
    `<a href="https://github.com/lvndry/jazz">jazz</a> daemon and a clone of ` +
    `<a href="${REPO}">quartet</a>. There is nothing hosted and nothing to sign up for.</p>` +
    `</main>` +
    `<footer><div class="foot-in">` +
    `<span>Quartet</span><span>MIT</span>` +
    `<span><a href="${REPO}">github.com/lvndry/quartet</a></span>` +
    `</div></footer>` +
    `<script>${SCRIPT}</script>` +
    `</body></html>`
  );
}
