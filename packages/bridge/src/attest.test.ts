import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, generateSealingKeypair, verifySealingKey, type Keypair } from "@quartet/identity";
import type { Message } from "@quartet/protocol";
import { Attestor } from "./attest";
import { Journal } from "./journal";

let workDir: string;
let mira: Keypair;
let otto: Keypair;

const context = () => ({ expectedDid: mira.did });

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "quartet-attest-"));
  mira = generateKeypair();
  otto = generateKeypair();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A fresh bridge process for the same agent, reading whatever the last one wrote. */
async function restart(who: string, keypair: Keypair): Promise<Attestor> {
  const attestor = new Attestor(keypair, new Journal(join(workDir, `chain-${who}.json`)));
  await attestor.ready();
  return attestor;
}

function say(author: Attestor, index: number, conversationId = "cnv_1"): Message {
  const text = `line ${String(index)}`;
  const dispatch = `dsp_${String(index)}`;
  const authorship = author.speak(conversationId, "agent", dispatch, text);
  const message: Message = {
    id: `msg_${String(index)}`,
    conversationId,
    authorDid: mira.did,
    kind: "agent",
    text,
    at: new Date().toISOString(),
    signature: {
      did: mira.did,
      authoredAt: authorship.authoredAt,
      nonce: authorship.nonce,
      prev: authorship.prev,
      dispatch,
      value: authorship.signature,
    },
  };
  author.confirmOwn(message);
  return message;
}

/** The saves are deliberately fire-and-forget, so let them land as a live process would. */
async function settle(): Promise<void> {
  await Bun.sleep(50);
}

describe("the chain across a restart", () => {
  it("does not cry gap when the author's own bridge merely restarted", async () => {
    const receiver = await restart("otto", otto);
    let sender = await restart("mira", mira);

    expect(receiver.check(say(sender, 1), context()).state).toBe("signed");
    expect(receiver.check(say(sender, 2), context()).state).toBe("signed");
    await settle();

    // A restart is an ordinary event. If it reported as tampering, the one warning that
    // matters would be the one everybody has learned to click past.
    sender = await restart("mira", mira);
    expect(receiver.check(say(sender, 3), context()).state).toBe("signed");
  });

  it("still catches a dropped line when the reader restarted in between", async () => {
    const sender = await restart("mira", mira);
    let receiver = await restart("otto", otto);

    expect(receiver.check(say(sender, 1), context()).state).toBe("signed");
    await settle();

    receiver = await restart("otto", otto);
    const withheld = say(sender, 2);
    void withheld;

    const verdict = receiver.check(say(sender, 3), context());
    expect(verdict.state).toBe("broken");
    expect(verdict.state === "broken" ? verdict.why : "").toContain("missing");
  });
});

describe("a line that arrives without a signature", () => {
  it("is a failure, not a shrug, when its author is known to sign", async () => {
    const sender = await restart("mira", mira);
    const receiver = await restart("otto", otto);
    const { signature: _stripped, ...unsigned } = say(sender, 1);

    const verdict = receiver.check(unsigned, context());
    expect(verdict.state).toBe("broken");
    expect(verdict.state === "broken" ? verdict.why : "").toContain("unsigned");
  });

  it("is unremarkable when it is the hub speaking in its own voice", async () => {
    const receiver = await restart("otto", otto);
    const system: Message = {
      id: "msg_sys",
      conversationId: "cnv_1",
      authorDid: mira.did,
      kind: "system",
      text: "stopped",
      at: new Date().toISOString(),
    };

    expect(receiver.check(system, context()).state).toBe("unsigned");
  });
});

describe("a transcript the hub replays on reconnect", () => {
  it("does not report a gap merely because the window has been seen before", async () => {
    const sender = await restart("mira", mira);
    const receiver = await restart("otto", otto);
    const window = [say(sender, 1), say(sender, 2), say(sender, 3)];
    for (const message of window) {
      expect(receiver.check(message, context()).state).toBe("signed");
    }

    // Welcome re-delivers the same lines. Judged against the running position they would
    // every one of them look out of order, and an alarm that fires on every reconnect is
    // one nobody reads by the third time.
    receiver.startWindow();
    for (const message of window) {
      expect(receiver.check(message, context(), { replay: true }).state).toBe("signed");
    }
    receiver.settleWindow();
  });

  it("still catches a line missing from the middle of that window", async () => {
    const sender = await restart("mira", mira);
    const receiver = await restart("otto", otto);
    const window = [say(sender, 1), say(sender, 2), say(sender, 3)];

    receiver.startWindow();
    const first = window[0];
    const third = window[2];
    if (first === undefined || third === undefined) throw new Error("window");

    expect(receiver.check(first, context(), { replay: true }).state).toBe("signed");
    const verdict = receiver.check(third, context(), { replay: true });
    expect(verdict.state).toBe("broken");
    expect(verdict.state === "broken" ? verdict.why : "").toContain("missing");
  });

  it("does not let a page of older history rewind where the live chain had reached", async () => {
    const sender = await restart("mira", mira);
    const receiver = await restart("otto", otto);
    const older = [say(sender, 1), say(sender, 2)];
    for (const message of older) receiver.check(message, context());

    // The browser scrolls back and the hub sends the older page. Settling it would move the
    // position backwards, and the next line to arrive live would look like a gap.
    receiver.startWindow();
    for (const message of older) receiver.check(message, context(), { replay: true });

    expect(receiver.check(say(sender, 3), context()).state).toBe("signed");
  });
});

describe("binding a sealing key to this identity", () => {
  it("signs the binding with the key the far side has pinned", () => {
    // The join between the two keypairs, and the only one. An X25519 key cannot vouch for
    // itself, so this signature is the entire difference between a key the agent published
    // and a key the hub made up.
    const attestor = new Attestor(mira, new Journal(join(workDir, "journal.json")));
    const { sealingDid } = generateSealingKeypair();

    const claim = attestor.bindSealingKey(sealingDid);

    expect(claim.sealingDid).toBe(sealingDid);
    expect(verifySealingKey({ did: mira.did, ...claim }, claim.proof)).toBe(true);
  });

  it("produces a claim that will not check out against anybody else's key", () => {
    const attestor = new Attestor(mira, new Journal(join(workDir, "journal.json")));
    const { sealingDid } = generateSealingKeypair();

    const claim = attestor.bindSealingKey(sealingDid);

    expect(verifySealingKey({ did: otto.did, ...claim }, claim.proof)).toBe(false);
  });

  it("covers the sealing key itself, so one cannot be swapped under a good signature", () => {
    const attestor = new Attestor(mira, new Journal(join(workDir, "journal.json")));
    const claim = attestor.bindSealingKey(generateSealingKeypair().sealingDid);
    const substituted = generateSealingKeypair().sealingDid;

    expect(
      verifySealingKey({ did: mira.did, sealingDid: substituted, at: claim.at }, claim.proof),
    ).toBe(false);
  });
});
