/**
 * In-memory model of the user's chat sessions, with persistence delegated to an
 * injected adapter. Kept `vscode`-free so it unit-tests on bare Node; the VS
 * Code layer wires {@link SessionPersistence} to `workspaceState`.
 *
 * Each session is the extension's own record of a conversation (title, our
 * transcript copy, and the linked `agy` conversation id). This backs the
 * two-step panel: a list of sessions (step 1) and a per-session chat (step 2).
 */
import { ChatMessage, Session } from "./types";

/** Storage adapter: load once at construction, save on every mutation. */
export interface SessionPersistence {
  load(): Session[];
  save(sessions: Session[]): void;
}

/** Derives a concise title from the first user message. */
export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 48) : "New chat";
}

export class SessionStore {
  private sessions: Session[];

  constructor(
    private readonly persistence: SessionPersistence,
    private readonly idgen: () => string,
    private readonly now: () => number
  ) {
    this.sessions = persistence.load();
  }

  /** Sessions, most-recently-updated first (for the list view). */
  list(): Session[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Session | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /**
   * Creates and persists a new, empty session. `options` carries the per-session
   * launch toggles chosen in the New Session menu (#5), stored so reopening the
   * session re-launches `agy` with the same flags.
   */
  create(options: { sandbox?: boolean; skipPermissions?: boolean } = {}): Session {
    const ts = this.now();
    const session: Session = {
      id: this.idgen(),
      title: "New chat",
      sandbox: options.sandbox,
      skipPermissions: options.skipPermissions,
      createdAt: ts,
      updatedAt: ts,
      messages: []
    };
    this.sessions.push(session);
    this.persist();
    return session;
  }

  delete(id: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.persist();
  }

  /** Appends a message; the first user message also becomes the title. */
  addMessage(id: string, message: ChatMessage): void {
    const session = this.get(id);
    if (!session) {
      return;
    }
    session.messages.push(message);
    session.updatedAt = this.now();
    if (message.role === "user" && (session.title === "New chat" || session.title === "")) {
      session.title = deriveTitle(message.text);
    }
    this.persist();
  }

  /** Records the agy conversation id once the first turn has run. */
  setConversationId(id: string, conversationId: string): void {
    const session = this.get(id);
    if (session && !session.conversationId) {
      session.conversationId = conversationId;
      this.persist();
    }
  }

  private persist(): void {
    this.persistence.save(this.sessions);
  }
}
