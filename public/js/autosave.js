// Saves card edits in the background: one request at a time; edits made meanwhile go in the next request.
export const SAVE_DELAY = 800;
export const RETRY_DELAY = 5000;
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function newSessionId() {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  // randomUUID needs a secure context; a team member may open the editor over plain http on the local network.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class Autosave {
  // save({id, fields, revision, session}) returns the saved card or throws an error with `status` (0 when offline).
  constructor({ save, onChange = () => {}, onSaved = () => {}, delay = SAVE_DELAY, retryDelay = RETRY_DELAY, clock = globalThis }) {
    Object.assign(this, { save, onChange, onSaved, delay, retryDelay, clock });
    this.id = null; this.revision = null; this.session = null; this.pending = {}; this.flight = null; this.timer = null;
    this.status = "saved"; this.error = ""; this.savedAt = null; this.lastSaved = null;
  }

  get dirty() { return Object.keys(this.pending).length > 0; }
  get busy() { return this.dirty || Boolean(this.flight); }
  get state() { return { status: this.status, error: this.error, savedAt: this.savedAt, dirty: this.dirty }; }

  open(post) {
    this.stop();
    Object.assign(this, { id: post.id, revision: post.revision, session: newSessionId(), pending: {}, flight: null, status: "saved", error: "", savedAt: null, lastSaved: null });
    this.emit();
  }

  close() { this.stop(); Object.assign(this, { id: null, pending: {}, flight: null, status: "saved", error: "" }); }

  edit(fields) {
    if (!this.id) return;
    Object.assign(this.pending, fields);
    // After a conflict nothing is sent until the user chooses whose version stays.
    if (this.status !== "conflict") { this.status = "dirty"; this.error = ""; this.later(this.delay); }
    this.emit();
  }

  // Sends everything that is pending. Resolves when the card is saved; rejects when saving is impossible right now.
  async flush() {
    this.stop();
    while (this.flight) await this.flight.catch(() => {});
    if (this.status === "conflict") throw Object.assign(new Error("Карточку изменили в другом месте. Выберите, чью версию оставить."), { status: 409 });
    if (!this.dirty) return this.lastSaved;
    const id = this.id, fields = { ...this.pending }, revision = this.revision, session = this.session;
    this.status = "saving"; this.error = ""; this.emit();
    const flight = this.save({ id, fields, revision, session });
    this.flight = flight;
    let post;
    try { post = await flight; }
    catch (error) {
      if (this.flight === flight) this.flight = null;
      if (id === this.id) this.fail(error);
      throw error;
    }
    if (this.flight === flight) this.flight = null;
    if (id !== this.id) return post;
    this.revision = post.revision; this.lastSaved = post;
    for (const [key, value] of Object.entries(fields)) if (sameValue(this.pending[key], value)) delete this.pending[key];
    this.savedAt = new Date(); this.error = "";
    this.status = this.dirty ? "dirty" : "saved";
    this.onSaved(post, fields);
    this.emit();
    return this.dirty ? this.flush() : post;
  }

  fail(error) {
    this.error = error.message || "Не удалось сохранить.";
    if (!error.status) { this.status = "offline"; this.later(this.retryDelay); }
    else if (error.status === 409 && /Версия изменилась/.test(this.error)) this.status = "conflict";
    else if (error.status === 409) this.status = "blocked";
    else this.status = "invalid";
    this.emit();
  }

  retry() { return this.flush().catch(() => null); }

  // The card changed outside autosave (agent result, upload, restore). Only an idle autosave follows it.
  adopt(post) {
    if (this.busy || post.id !== this.id) return false;
    if (post.revision !== this.revision && post.lastChange?.origin !== "manual") this.session = newSessionId();
    this.revision = post.revision;
    if (["blocked", "invalid"].includes(this.status)) { this.status = "saved"; this.error = ""; this.emit(); }
    return true;
  }

  // Conflict resolution: put all local values on top of the latest revision, or drop them.
  keepMine(post, fields) {
    Object.assign(this, { revision: post.revision, pending: { ...fields }, session: newSessionId(), status: "dirty", error: "" });
    this.emit();
    return this.flush();
  }

  discard(post) {
    this.stop();
    Object.assign(this, { revision: post.revision, pending: {}, session: newSessionId(), status: "saved", error: "" });
    this.emit();
  }

  later(delay) { this.stop(); this.timer = this.clock.setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, delay); }
  stop() { if (this.timer) this.clock.clearTimeout(this.timer); this.timer = null; }
  emit() { this.onChange(this.state); }
}
