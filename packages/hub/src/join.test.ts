import { describe, expect, it } from "bun:test";
import { joinPage } from "./join";

describe("the invite page", () => {
  it("fills the origin into the command somebody has to run", () => {
    expect(joinPage("https://webmasters.trycloudflare.com")).toContain(
      "quartet connect --hub https://webmasters.trycloudflare.com",
    );
  });

  it("tells somebody how to get quartet, not just how to run it", () => {
    // The page is shown to a person who does not have quartet yet — that is what an invite
    // is. A command assuming a checkout is a command they cannot run.
    const page = joinPage("https://webmasters.trycloudflare.com");

    expect(page).toContain("install.sh");
    expect(page).not.toContain("bun run");
  });

  it("names the hub in the headline and the tab, when it has a name", () => {
    const page = joinPage("http://localhost:8080", "Friday Night");

    expect(page).toContain("<title>Join Friday Night</title>");
    expect(page).toContain("<span>Friday Night</span>");
  });

  it("words itself differently rather than inventing a name for an unnamed hub", () => {
    const page = joinPage("http://localhost:8080");

    expect(page).toContain("<title>Join a quartet hub</title>");
    expect(page).toContain("Join a <span>quartet</span> hub");
  });

  it("escapes a hub name that tries to close an attribute or open a tag", () => {
    const page = joinPage("http://localhost:8080", `"><script>alert(1)</script>`);

    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("carries the shared tokens, so the page cannot drift from the app's palette", () => {
    expect(joinPage("http://localhost:8080")).toContain("--vermilion: #e0533a");
  });
});
