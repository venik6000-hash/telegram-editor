// The agent panel: what to prepare, the instruction with attachments, and the card's journal of runs.
import { IMAGE_TYPES, projectUrl, safeHttpUrl } from "./api.js";

const TARGETS = { text: "Текст", image: "Картинка", post: "Пост целиком" };
const STATUSES = { running: "В работе", completed: "Готово", failed: "Ошибка", blocked: "Похожий уже был", question: "Вопрос агента", cancelled: "Остановлено" };
const PLACEHOLDERS = {
  text: "Например: сократи вступление и добавь ссылку на https://…",
  image: "Например: возьми логотип с example.com и поставь его на обложку",
  post: "Например: пост о новом сервисе; вот его сайт example.com — возьми оттуда логотип для картинки",
};
const HINTS = {
  text: "Автор перепишет текст по инструкции, редактор проверит. Пока агент работает, текст закрыт для правки.",
  image: "Текст можно править, пока агент рисует. Картинка добавится вариантом, прошлые останутся в ленте.",
  post: "Сначала текст (автор и проверяющий), затем картинка по готовому тексту.",
};
const DRAFTS_KEY = "editor-agent-drafts";
const host = (value) => { try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return String(value || ""); } };
function when(value) {
  const date = new Date(value || ""); if (Number.isNaN(date.valueOf())) return "";
  const today = new Date().toDateString() === date.toDateString();
  return new Intl.DateTimeFormat("ru-RU", today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}
function node(tag, className = "", text = "") { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; }
function link(url, text) {
  const safe = safeHttpUrl(url); const element = node(safe ? "a" : "span", "", text || host(url));
  if (safe) { element.href = safe; element.target = "_blank"; element.rel = "noopener noreferrer"; element.title = safe; }
  return element;
}

export class AgentPanel {
  constructor({ onRun, onStop, onUpload, onSelectVariant, onError, findUrls }) {
    this.options = { onRun, onStop, onUpload, onSelectVariant, onError, findUrls };
    const $ = (id) => document.getElementById(id);
    this.e = { panel: $("agent-panel"), state: $("agent-state"), mode: $("agent-mode"), instruction: $("agent-instruction"), urls: $("agent-urls"), attachments: $("agent-attachments"), run: $("agent-run"), stop: $("agent-stop"), hint: $("agent-hint"), log: $("agent-log") };
    this.targets = [...this.e.panel.querySelectorAll('input[name="agent-target"]')];
    this.modes = [...this.e.panel.querySelectorAll('input[name="agent-mode"]')];
    this.drafts = this.loadDrafts(); this.key = null; this.post = null; this.view = { reason: "" }; this.starting = false; this.uploading = 0;
    this.replies = new Map(); this.opened = new Set(); this.logSignature = "";
    for (const radio of this.targets) radio.addEventListener("change", () => { this.draft().target = radio.value; this.remember(); this.sync(); });
    for (const radio of this.modes) radio.addEventListener("change", () => { this.draft().mode = radio.value; this.remember(); this.sync(); });
    this.e.instruction.addEventListener("input", () => { this.draft().instruction = this.e.instruction.value; this.remember(); this.renderUrls(); });
    this.e.instruction.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); this.run(); } });
    this.e.run.addEventListener("click", () => this.run());
    this.e.stop.addEventListener("click", () => this.options.onStop());
  }

  loadDrafts() { try { return new Map(JSON.parse(sessionStorage.getItem(DRAFTS_KEY) || "[]")); } catch { return new Map(); } }
  remember() { clearTimeout(this.rememberTimer); this.rememberTimer = setTimeout(() => { try { sessionStorage.setItem(DRAFTS_KEY, JSON.stringify([...this.drafts].slice(-50))); } catch { /* private mode */ } }, 300); }
  draft() {
    if (!this.drafts.has(this.key)) this.drafts.set(this.key, { target: String(this.post?.text || "").trim() ? "text" : "post", mode: this.post?.image ? "edit" : "new", instruction: "", attachments: [] });
    return this.drafts.get(this.key);
  }

  // view: {running, reason, canStop}
  show(post, key, view) {
    const switched = key !== this.key;
    this.key = key; this.post = post; this.view = view;
    const draft = this.draft();
    if (switched || document.activeElement !== this.e.instruction) this.e.instruction.value = draft.instruction;
    this.sync();
    // The journal is rebuilt only when it changes, so a half-typed answer and open sections survive autosave.
    const signature = JSON.stringify([key, post.agentLog, post.job?.id, post.job?.status, post.job?.phase, post.image?.name, (post.imageVariants || []).map((item) => item.name), view.reason, view.running]);
    if (signature !== this.logSignature) { this.logSignature = signature; this.renderLog(); }
  }

  mode() { const draft = this.draft(); return draft.mode === "edit" && this.post?.image ? "edit" : "new"; }

  sync() {
    if (!this.post) return;
    const draft = this.draft(), { e, view } = this;
    for (const radio of this.targets) radio.checked = radio.value === draft.target;
    const mode = this.mode();
    for (const radio of this.modes) { radio.checked = radio.value === mode; radio.disabled = radio.value === "edit" && !this.post.image; }
    e.mode.hidden = draft.target !== "image";
    e.instruction.placeholder = PLACEHOLDERS[draft.target];
    const blocked = Boolean(view.reason) || view.running || this.starting;
    e.run.disabled = blocked || this.uploading > 0;
    e.run.textContent = this.starting ? "Запускаем…" : `Запустить: ${TARGETS[draft.target].toLocaleLowerCase("ru-RU")}`;
    e.stop.hidden = !view.running; e.stop.disabled = !view.canStop;
    e.hint.textContent = view.running ? "Агент работает. Его ход виден в журнале ниже." : view.reason || HINTS[draft.target];
    e.hint.classList.toggle("warning", Boolean(view.reason) && !view.running);
    const job = this.post.job;
    e.state.textContent = view.running ? `${TARGETS[job?.kind] || "Агент"} · ${job?.phase || "в работе"}` : "";
    e.state.hidden = !view.running;
    this.renderUrls(); this.renderAttachments();
  }

  renderUrls() {
    const urls = this.options.findUrls(this.e.instruction.value || "");
    this.e.urls.replaceChildren();
    this.e.urls.hidden = !urls.length;
    if (!urls.length) return;
    this.e.urls.append(node("span", "", "Агент посмотрит:"));
    for (const url of urls) this.e.urls.append(link(url, host(url)));
  }

  renderAttachments() {
    const draft = this.draft(), { attachments } = this.e;
    attachments.replaceChildren();
    for (const item of draft.attachments) {
      const tile = node("figure", "attachment");
      const image = document.createElement("img"); image.src = projectUrl(item.url); image.alt = ""; image.title = item.label || item.name;
      const remove = node("button", "attachment-remove", "×"); remove.type = "button"; remove.setAttribute("aria-label", `Убрать вложение ${item.label || ""}`);
      remove.addEventListener("click", () => { draft.attachments = draft.attachments.filter((other) => other.id !== item.id); this.remember(); this.renderAttachments(); });
      tile.append(image, remove); attachments.append(tile);
    }
    if (draft.attachments.length >= 6) return;
    const add = node("label", `attachment-add${this.view.reason ? " disabled" : ""}`);
    add.title = "Приложить изображение для агента: логотип, фото, пример (PNG, JPEG или WebP до 8 МБ)";
    const input = document.createElement("input"); input.type = "file"; input.accept = IMAGE_TYPES.join(","); input.multiple = true; input.disabled = Boolean(this.view.reason);
    input.addEventListener("change", () => { const files = [...input.files]; input.value = ""; this.upload(files); });
    add.append(input, node("span", "", this.uploading ? "Загружаем…" : "+ Файл для агента"));
    attachments.append(add);
  }

  async upload(files) {
    const key = this.key, postId = this.post.id;
    for (const file of files.slice(0, 6 - this.draft().attachments.length)) {
      this.uploading += 1; this.sync();
      try { const attachment = await this.options.onUpload(file, postId); const draft = this.drafts.get(key); if (draft && !draft.attachments.some((item) => item.id === attachment.id)) draft.attachments.push(attachment); this.remember(); }
      catch (error) { this.options.onError(error.message); }
      finally { this.uploading -= 1; this.sync(); }
    }
  }

  async run(extra = {}) {
    if (this.starting || this.view.reason || this.view.running) return;
    const key = this.key, draft = this.draft();
    const request = extra.replyTo || extra.overrideReason ? extra : { target: draft.target, instruction: draft.instruction.trim(), attachmentIds: draft.attachments.map((item) => item.id), ...(draft.target === "image" ? { mode: this.mode() } : {}) };
    this.starting = true; this.sync();
    try {
      await this.options.onRun(request);
      if (!extra.replyTo && !extra.overrideReason) { const saved = this.drafts.get(key); if (saved) { saved.instruction = ""; saved.attachments = []; } if (this.key === key) this.e.instruction.value = ""; this.remember(); }
      return true;
    } catch { return false; }
    finally { this.starting = false; this.sync(); }
  }

  reuse(entry) {
    const draft = this.draft();
    Object.assign(draft, { target: entry.target, mode: entry.mode || draft.mode, instruction: entry.instruction || "" });
    this.e.instruction.value = draft.instruction; this.remember(); this.sync(); this.e.instruction.focus();
  }

  renderLog() {
    const post = this.post, entries = [...(post?.agentLog || [])].reverse();
    this.e.log.replaceChildren();
    if (!entries.length) { this.e.log.append(node("p", "empty-list", "Агент ещё не запускался. Здесь появятся его запуски, вопросы и результаты.")); return; }
    entries.forEach((entry, index) => this.e.log.append(this.entry(entry, index === 0)));
  }

  entry(entry, newest) {
    const post = this.post, article = node("article", "log-entry"); article.dataset.status = entry.status;
    const head = node("header", "log-head");
    const title = node("strong", "", `${TARGETS[entry.target] || entry.target}${entry.target === "image" && entry.mode ? ` · ${entry.mode === "edit" ? "доработка" : "новая"}` : ""}`);
    head.append(title, node("time", "", when(entry.at)), node("span", "log-status", STATUSES[entry.status] || entry.status));
    article.append(head);
    if (entry.replyQuestion) article.append(node("p", "log-reply", `Ответ на вопрос «${entry.replyQuestion}»`));
    article.append(node("p", `log-instruction${entry.instruction ? "" : " muted"}`, entry.instruction || "Без инструкции"));
    if (entry.overrideReason) article.append(node("p", "log-note", `Новый угол: ${entry.overrideReason}`));
    if (entry.attachments?.length) {
      const row = node("div", "log-thumbs");
      for (const item of entry.attachments) { const image = document.createElement("img"); image.src = projectUrl(item.url); image.alt = ""; image.title = item.label || item.name; row.append(image); }
      article.append(row);
    }
    if (entry.sites?.length) {
      const row = node("div", "log-sites");
      for (const site of entry.sites) {
        const chip = node("span", `site-chip ${site.status}`);
        chip.append(link(site.finalUrl || site.url, host(site.finalUrl || site.url)));
        if (site.status === "error") chip.append(node("small", "", ` — ${site.error || "не открылся"}`));
        if (site.status === "pending") chip.append(node("small", "", " — ждёт"));
        row.append(chip);
      }
      article.append(row);
    }
    const running = entry.status === "running";
    if (running) article.append(node("p", "log-phase", post.job?.id === entry.id ? post.job.phase || entry.phase : entry.phase || "В работе"));
    if (entry.status === "completed") this.results(article, entry);
    if (entry.usedAssets?.length) {
      const used = node("div", "log-used"); used.append(node("span", "", "Взято:"));
      for (const item of entry.usedAssets) {
        const chip = node("span", "used-asset");
        if (item.url) { const image = document.createElement("img"); image.src = projectUrl(item.url); image.alt = ""; chip.append(image); }
        chip.append(node("span", "", item.label || (item.role === "current" ? "текущая картинка" : "вложение")));
        if (item.sourceUrl) chip.append(link(item.sourceUrl, host(item.sourceUrl)));
        used.append(chip);
      }
      article.append(used);
    }
    if (entry.note) article.append(node("p", "log-note", `Агент: ${entry.note}`));
    if (entry.candidates?.length) {
      const details = node("details", "log-candidates"); details.append(node("summary", "", `Найдено на сайтах: ${entry.candidates.length}`));
      details.open = this.opened.has(entry.id);
      details.addEventListener("toggle", () => { if (details.open) this.opened.add(entry.id); else this.opened.delete(entry.id); });
      for (const item of entry.candidates) { const row = node("div"); row.append(link(item.sourceUrl, item.label || host(item.sourceUrl))); details.append(row); }
      article.append(details);
    }
    if (entry.status === "failed" && entry.error) article.append(node("p", "log-error", entry.error));
    if (entry.status === "question") {
      article.append(node("p", "log-question", entry.question || "Агенту не хватает данных."));
      // A post that stopped at the picture already has its text: the answer goes to the picture step only.
      const target = entry.target === "post" && (entry.step === "image" || entry.results?.text) ? "image" : entry.target;
      const mode = target !== entry.target ? "new" : entry.mode === "edit" && post.image ? "edit" : "new";
      if (newest) article.append(this.replyForm(`${entry.id}:answer`, "Ответ агенту", "Ответить и продолжить", (text) => this.run({ target, ...(target === "image" ? { mode } : {}), instruction: text, replyTo: entry.id })));
    }
    if (entry.status === "blocked") {
      article.append(node("p", "log-error", entry.error || "Похожий материал уже опубликован."));
      for (const match of entry.duplicate?.matches || []) { const row = node("div", "log-match"); row.append(link(match.url, match.title || match.id)); article.append(row); }
      if (newest) article.append(this.replyForm(`${entry.id}:angle`, "Новый угол", "Запустить с этим углом", (text) => this.run({ target: entry.target, instruction: entry.instruction, overrideReason: text })));
    }
    if (!running) {
      const reuse = node("button", "text-button neutral log-reuse", "Повторить с этой инструкцией"); reuse.type = "button";
      reuse.addEventListener("click", () => this.reuse(entry));
      article.append(reuse);
    }
    return article;
  }

  results(article, entry) {
    const post = this.post, results = entry.results || {};
    if (results.text) article.append(node("p", "log-result", "Текст обновлён."));
    if (!results.image) return;
    const variant = (post.imageVariants || []).find((item) => item.name === results.image.name);
    const figure = node("figure", "log-image");
    if (variant) { const image = document.createElement("img"); image.src = projectUrl(variant.url); image.alt = "Картинка этого запуска"; figure.append(image); }
    const current = post.image?.name === results.image.name;
    const caption = node("figcaption", "", current ? "Сейчас на посте" : "Новая картинка");
    if (!current && variant) {
      const put = node("button", "text-button neutral", "Вернуть на пост"); put.type = "button"; put.disabled = Boolean(this.view.reason) || this.view.running;
      put.addEventListener("click", () => this.options.onSelectVariant(variant));
      caption.append(put);
    }
    figure.append(caption); article.append(figure);
  }

  replyForm(key, label, action, submit) {
    const form = node("div", "log-reply-form");
    const input = document.createElement("textarea"); input.rows = 2; input.maxLength = 4000; input.setAttribute("aria-label", label); input.placeholder = label;
    input.value = this.replies.get(key) || "";
    input.addEventListener("input", () => this.replies.set(key, input.value));
    const button = node("button", "button button-primary", action); button.type = "button"; button.disabled = Boolean(this.view.reason) || this.view.running;
    button.addEventListener("click", async () => { const text = input.value.trim(); if (!text) { input.focus(); return; } button.disabled = true; if (await submit(text)) this.replies.delete(key); else button.disabled = false; });
    form.append(input, button);
    return form;
  }
}
