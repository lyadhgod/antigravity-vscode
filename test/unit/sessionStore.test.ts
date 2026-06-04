import * as assert from "node:assert";

import { SessionStore, deriveTitle } from "../../src/core/sessionStore";
import { Session } from "../../src/core/types";

/** In-memory persistence that records what was saved. */
function makePersistence(initial: Session[] = []) {
  let saved = initial.slice();
  return { adapter: { load: () => saved, save: (s: Session[]) => { saved = s; } }, saved: () => saved };
}

/** Builds a store with deterministic ids and a monotonically increasing clock. */
function makeStore(initial: Session[] = []) {
  const p = makePersistence(initial);
  let n = 0;
  let clock = 1000;
  const store = new SessionStore(p.adapter, () => `s${++n}`, () => (clock += 1));
  return { store, persistence: p };
}

describe("sessionStore.deriveTitle", () => {
  it("collapses whitespace and truncates", () => {
    assert.strictEqual(deriveTitle("  hello   world  "), "hello world");
    assert.strictEqual(deriveTitle("x".repeat(80)).length, 48);
    assert.strictEqual(deriveTitle("   "), "New chat");
  });
});

describe("sessionStore.SessionStore", () => {
  it("creates and persists a session", () => {
    const { store, persistence } = makeStore();
    const s = store.create();
    assert.strictEqual(s.id, "s1");
    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(persistence.saved().length, 1);
  });

  it("stores the per-session launch options (#5)", () => {
    const { store } = makeStore();
    const s = store.create({ sandbox: true, skipPermissions: true });
    assert.strictEqual(store.get(s.id)?.sandbox, true);
    assert.strictEqual(store.get(s.id)?.skipPermissions, true);
    // Defaults to undefined when not provided.
    const plain = store.create();
    assert.strictEqual(store.get(plain.id)?.sandbox, undefined);
  });

  it("titles a session from its first user message only", () => {
    const { store } = makeStore();
    const s = store.create();
    store.addMessage(s.id, { role: "user", text: "Refactor the parser please" });
    store.addMessage(s.id, { role: "user", text: "second message" });
    assert.strictEqual(store.get(s.id)?.title, "Refactor the parser please");
  });

  it("captures the conversation id once and does not overwrite it", () => {
    const { store } = makeStore();
    const s = store.create();
    store.setConversationId(s.id, "conv-1");
    store.setConversationId(s.id, "conv-2");
    assert.strictEqual(store.get(s.id)?.conversationId, "conv-1");
  });

  it("deletes a session and persists the removal", () => {
    const { store, persistence } = makeStore();
    const s = store.create();
    store.delete(s.id);
    assert.strictEqual(store.get(s.id), undefined);
    assert.strictEqual(persistence.saved().length, 0);
  });

  it("lists most-recently-updated first", () => {
    const { store } = makeStore();
    const a = store.create();
    const b = store.create();
    store.addMessage(a.id, { role: "user", text: "touch a last" }); // bumps a.updatedAt
    assert.strictEqual(store.list()[0].id, a.id);
    assert.strictEqual(store.list()[1].id, b.id);
  });
});
