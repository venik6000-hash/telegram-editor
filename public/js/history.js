// Card history: a compact list of states with what changed, and a dialog that compares a version with the current text.
import { diffWords } from "./diff.js";

const FIELD_NAMES = { text: "текст", title: "название", brief: "задание", image: "картинка", dueAt: "срок", topic: "тема", sources: "источники", assignedTo: "исполнитель" };
const COMPARED = ["title", "brief", "text", "entities", "image", "sources", "topic", "dueAt"];
const clip = (value, limit) => { const text = String(value || "").replace(/\s+/g, " ").trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const time = (value) => { const date = new Date(value || ""); return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(date); };

export function changedFields(before, after) {
  if (!before) return [];
  const fields = COMPARED.filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)).map((key) => key === "entities" ? "text" : key);
  return [...new Set(fields)];
}

export function changeLabel(change, fields = [], { userName = "" } = {}) {
  const names = fields.map((field) => FIELD_NAMES[field]).filter(Boolean).join(", ");
  switch (change?.origin) {
    case "agent": return names ? `Агент · ${names}` : "Агент";
    case "upload": return "Загрузка картинки";
    case "variant": return "Вариант картинки";
    case "restore": return "Восстановление";
    case "links": return "Ссылки";
    case "manual": { const who = change.by && userName && change.by !== userName ? change.by : "Вы"; return names ? `${who} · ${names}` : who; }
    default: return names ? `Правка · ${names}` : "Правка";
  }
}

// States from newest to oldest. Each state says how it came about; old snapshots without a record are compared with the previous state.
export function historyEntries(post, options = {}) {
  const states = [...(post.history || [])].sort((a, b) => a.revision - b.revision);
  const current = { revision: post.revision, topic: post.topic, title: post.title, brief: post.brief, text: post.text, entities: post.entities || [], image: post.image, sources: post.sources, dueAt: post.dueAt ?? null, savedAt: post.updatedAt, change: post.lastChange };
  const all = [...states, current];
  return all.map((state, index) => {
    const previous = all[index - 1];
    const fields = state.change?.fields?.length ? state.change.fields : changedFields(previous, state);
    const label = !state.change && state.revision === 1 ? "Создание" : changeLabel(state.change, fields, options);
    const imageChanged = fields.includes("image") || (!previous && Boolean(state.image));
    return { revision: state.revision, at: state.change?.at || state.savedAt, label, fields, instruction: state.change?.instruction || "", imageChanged, image: state.image, current: state === current, version: state };
  }).reverse();
}

export function renderHistory(container, post, { onOpen, projectUrl = (url) => url, userName = "", limit = 30 }) {
  const entries = historyEntries(post, { userName });
  container.replaceChildren();
  if (entries.length === 1) { const empty = document.createElement("div"); empty.className = "empty-list"; empty.textContent = "Предыдущих версий нет"; container.append(empty); }
  const shown = container.dataset.all === "true" ? entries : entries.slice(0, limit);
  for (const entry of shown) {
    if (entries.length === 1) break;
    const row = document.createElement("button");
    row.type = "button"; row.className = `history-row${entry.current ? " current" : ""}`;
    const main = document.createElement("span"); main.className = "history-main";
    const label = document.createElement("strong"); label.textContent = entry.current ? `Сейчас · ${entry.label}` : entry.label;
    const meta = document.createElement("small"); meta.textContent = [time(entry.at), `версия ${entry.revision}`].filter(Boolean).join(" · ");
    main.append(label, meta);
    if (entry.instruction) { const note = document.createElement("em"); note.textContent = `«${clip(entry.instruction, 90)}»`; main.append(note); }
    row.append(main);
    if (entry.imageChanged && entry.image?.url) { const image = document.createElement("img"); image.src = projectUrl(entry.image.url); image.alt = ""; image.loading = "lazy"; row.append(image); }
    row.addEventListener("click", () => onOpen(entry));
    container.append(row);
  }
  if (entries.length > shown.length) {
    const more = document.createElement("button"); more.type = "button"; more.className = "text-button neutral"; more.textContent = `Показать все версии (${entries.length})`;
    more.addEventListener("click", () => { container.dataset.all = "true"; renderHistory(container, post, { onOpen, projectUrl, userName, limit }); });
    container.append(more);
  }
}

export class VersionDialog {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.elements = { dialog: $("version-dialog"), title: $("version-title"), meta: $("version-meta"), text: $("version-text"), legend: $("version-legend"), image: $("version-image"), fields: $("version-fields"), error: $("version-error"), restoreText: $("version-restore-text"), restoreAll: $("version-restore-all") };
    this.handlers = null;
    this.elements.restoreText.addEventListener("click", () => this.run("text"));
    this.elements.restoreAll.addEventListener("click", () => this.run("all"));
  }

  open(entry, post, { canRestore, onRestoreAll, onRestoreText, projectUrl = (url) => url }) {
    const { elements } = this, version = entry.version;
    this.handlers = { all: onRestoreAll, text: onRestoreText, entry };
    elements.title.textContent = entry.current ? "Текущая версия" : `Версия ${entry.revision}`;
    elements.meta.textContent = [entry.label, time(entry.at), entry.instruction && `инструкция: «${clip(entry.instruction, 300)}»`].filter(Boolean).join(" · ");
    elements.text.replaceChildren();
    const parts = entry.current ? [{ type: "same", text: version.text || "" }] : diffWords(post.text || "", version.text || "");
    for (const part of parts) {
      if (part.type === "same") { elements.text.append(document.createTextNode(part.text)); continue; }
      const mark = document.createElement(part.type === "added" ? "ins" : "del"); mark.textContent = part.text; elements.text.append(mark);
    }
    if (!version.text) elements.text.textContent = "Текста в этой версии нет.";
    elements.legend.hidden = entry.current || version.text === post.text;
    elements.image.replaceChildren();
    if (version.image?.url) {
      const image = document.createElement("img"); image.className = "version-image"; image.src = projectUrl(version.image.url); image.alt = "Картинка версии"; elements.image.append(image);
      if (version.image.name === post.image?.name) { const same = document.createElement("small"); same.textContent = "Такая же картинка сейчас на посте."; elements.image.append(same); }
    } else { const none = document.createElement("small"); none.textContent = "Картинки в этой версии нет."; elements.image.append(none); }
    elements.fields.replaceChildren();
    for (const [key, name] of [["title", "Название"], ["brief", "Задание"]]) {
      if (entry.current || (version[key] || "") === (post[key] || "")) continue;
      const row = document.createElement("p"); const label = document.createElement("strong"); label.textContent = `${name} в версии: `; row.append(label, document.createTextNode(version[key] || "не указано")); elements.fields.append(row);
    }
    const sameText = version.text === post.text && JSON.stringify(version.entities || []) === JSON.stringify(post.entities || []);
    elements.restoreText.hidden = entry.current; elements.restoreAll.hidden = entry.current;
    elements.restoreText.disabled = !canRestore || sameText; elements.restoreAll.disabled = !canRestore;
    elements.restoreText.title = sameText ? "Текст этой версии совпадает с текущим" : "";
    elements.error.hidden = true;
    if (!elements.dialog.open) elements.dialog.showModal();
  }

  async run(kind) {
    const handler = this.handlers?.[kind];
    if (!handler) return;
    const { restoreText, restoreAll, error } = this.elements;
    restoreText.disabled = true; restoreAll.disabled = true; error.hidden = true;
    try { await handler(this.handlers.entry); this.elements.dialog.close(); }
    catch (failure) { error.textContent = failure.message; error.hidden = false; restoreAll.disabled = false; restoreText.disabled = false; }
  }
}
