// The open card: sticky header, the post as it will look in Telegram, picture variants, details, history and the agent panel.
import { api, send, postPath, readAsDataUrl, checkImageFile, projectUrl, safeHttpUrl, plural } from "./api.js";
import { Autosave } from "./autosave.js";
import { renderRichText, readRichText, bindRichEditor, applyFormat, selectionOffsets, restoreSelection, canonicalEntities, safeLinkUrl } from "../rich-text.js";
import { renderVariants } from "./variants.js";
import { renderHistory, VersionDialog } from "./history.js";
import { PublishDialog } from "./publish-dialog.js";
import { AgentPanel } from "./agent-panel.js";
import { hasMarkdownLinks } from "/shared/links.mjs";
import { findUrls } from "/shared/urls.mjs";

const STATUS_LABELS = { idea: "Идея", working: "В работе", review: "На проверке", approved: "Согласовано", scheduled: "Запланировано", publishing: "Публикуется", published: "Опубликовано", missed: "Пропущено", failed: "Ошибка", uncertain: "Нужна сверка" };
const IDS = ["empty-state", "editor-content", "card-title", "post-status", "save-indicator", "save-retry", "agent-indicator", "archive-back-button", "scheduled-state", "unschedule-button", "schedule-open-button", "publish-open-button", "conflict-banner", "conflict-keep", "conflict-take", "error-banner", "notice-banner", "readonly-banner", "readonly-text", "readonly-action", "image-preview", "image-overlay", "remove-image-button", "variants", "format-toolbar", "link-popover", "link-url", "link-apply", "link-remove", "link-cancel", "link-error", "text-input", "post-info", "links-notice", "convert-links-button", "preview-issues", "details-section", "title-input", "brief-input", "due-at-input", "sources-count", "sources-list", "history-count", "history-list", "destination", "preview-parts", "publication-panel", "uncertain-panel", "message-ids-input", "reconcile-button"];

const isPublished = (post) => post?.status === "published" && post?.publication?.status === "published";
const isScheduled = (post) => post?.status === "scheduled" && post?.schedule?.status === "scheduled";
const jobRunning = (post) => ["running", "working"].includes(post?.job?.status);
const imageBusy = (post) => jobRunning(post) && ["image", "post"].includes(post.job.kind);
const displayStatus = (post) => post?.status === "published" && post?.publication?.status && post.publication.status !== "published" ? post.publication.status : post?.status;
const toLocalInput = (value) => { if (!value) return ""; const date = new Date(value); return Number.isNaN(date.valueOf()) ? "" : new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const formatDate = (value) => { const date = new Date(value || ""); return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(date); };
const clock = (value) => new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(value);

// Mirrors the server split: a caption up to 1024 characters, otherwise messages of up to 4096 characters.
export function messageCount(text) {
  let rest = String(text || ""), count = 0;
  while (rest.length) {
    let end = Math.min(rest.length, 4096);
    if (end < rest.length) { const para = rest.lastIndexOf("\n", end - 1), word = rest.lastIndexOf(" ", end - 1); if (para > 2048) end = para + 1; else if (word > 2048) end = word + 1; }
    rest = rest.slice(end); count += 1;
  }
  return count;
}

export class CardView {
  // context(): {projectId, settings, codex, user, can(action), archiveOrigin, agentBusyElsewhere}
  constructor({ context, onPostChanged = () => {}, onArchiveBack = () => {} }) {
    this.context = context; this.onPostChanged = onPostChanged; this.onArchiveBack = onArchiveBack;
    this.e = Object.fromEntries(IDS.map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));
    this.post = null; this.preview = null; this.generation = 0; this.acting = false; this.linkRange = null;
    this.autosave = new Autosave({
      save: ({ id, fields, revision, session }) => send(postPath(id), "PATCH", { revision, session, ...fields }),
      onChange: (state) => this.renderSaveState(state),
      onSaved: (post) => this.onSaved(post),
    });
    this.versions = new VersionDialog();
    this.publishDialog = new PublishDialog();
    this.agent = new AgentPanel({ onRun: (request) => this.runAgent(request), onStop: () => this.stopAgent(), onUpload: (file) => this.uploadAttachment(file), onSelectVariant: (variant) => this.selectVariant(variant), onError: (message) => this.error(message), findUrls });
    this.bind();
  }

  bind() {
    const { e } = this;
    bindRichEditor(e.text_input, () => this.onTextInput(), { toolbar: e.format_toolbar, onLink: (offsets, link) => this.openLink(offsets, link), onSave: () => this.saveNow() });
    e.text_input.addEventListener("input", () => this.onTextInput());
    e.text_input.addEventListener("blur", () => this.saveSoon());
    e.title_input.addEventListener("input", () => { this.autosave.edit({ title: e.title_input.value }); e.card_title.textContent = e.title_input.value || "Без названия"; });
    e.brief_input.addEventListener("input", () => this.autosave.edit({ brief: e.brief_input.value }));
    e.due_at_input.addEventListener("change", () => { this.autosave.edit({ dueAt: e.due_at_input.value ? new Date(e.due_at_input.value).toISOString() : null }); this.saveSoon(); });
    for (const input of [e.title_input, e.brief_input]) input.addEventListener("blur", () => this.saveSoon());
    e.save_retry.addEventListener("click", () => this.autosave.retry());
    e.conflict_keep.addEventListener("click", () => this.resolveConflict(true));
    e.conflict_take.addEventListener("click", () => this.resolveConflict(false));
    e.remove_image_button.addEventListener("click", () => this.removeImage());
    e.convert_links_button.addEventListener("click", () => this.convertLinks());
    e.publish_open_button.addEventListener("click", () => this.openPublish("now"));
    e.schedule_open_button.addEventListener("click", () => this.openPublish("at"));
    e.unschedule_button.addEventListener("click", () => this.unschedule());
    e.readonly_action.addEventListener("click", () => this.unschedule());
    e.reconcile_button.addEventListener("click", () => this.reconcile());
    e.archive_back_button.addEventListener("click", () => this.onArchiveBack());
    e.link_apply.addEventListener("click", () => this.applyLink(false));
    e.link_remove.addEventListener("click", () => this.applyLink(true));
    e.link_cancel.addEventListener("click", () => this.hideLink());
    e.link_url.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); this.applyLink(false); } if (event.key === "Escape") { event.preventDefault(); this.hideLink(); } });
    e.agent_indicator.addEventListener("click", () => document.getElementById("agent-panel").scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  // --- lifecycle ---
  async open(id) {
    const generation = ++this.generation;
    this.hideLink(); this.clearMessages();
    this.e.empty_state.hidden = true; this.e.editor_content.hidden = false; this.e.editor_content.classList.add("loading");
    try {
      const post = await api(postPath(id));
      if (generation !== this.generation) return;
      this.post = post; this.preview = null;
      this.autosave.open(post);
      this.e.details_section.open = !String(post.text || "").trim();
      this.e.history_list.dataset.all = "false";
      this.renderText(post, false); this.renderFields(post, true); this.render();
      this.loadPreview();
    } catch (error) { if (generation === this.generation) this.error(error.message); }
    finally { if (generation === this.generation) this.e.editor_content.classList.remove("loading"); }
  }

  close() {
    this.generation += 1; this.autosave.close(); this.post = null; this.preview = null; this.hideLink();
    this.e.editor_content.hidden = true; this.e.empty_state.hidden = false;
  }

  hasUnsaved() { return Boolean(this.post) && this.autosave.busy; }
  saveNow() { this.autosave.flush().catch(() => {}); }
  saveSoon() { if (this.autosave.dirty) this.autosave.flush().catch(() => {}); }

  // Before switching card or project: save, or ask whether to drop unsaved edits.
  async leave() {
    if (!this.post || !this.autosave.busy) return true;
    try { await this.autosave.flush(); return true; }
    catch (error) { return window.confirm(`Правки не сохранены: ${error.message}\nВсё равно уйти? Несохранённые правки пропадут.`); }
  }

  async ensureSaved() {
    try { await this.autosave.flush(); }
    catch (error) { throw new Error(error.status === 0 ? "Нет связи с редакцией: правки ещё не сохранены." : `Правки не сохранены: ${error.message}`); }
  }

  // --- updates from outside ---
  syncSummary(summary) {
    const post = this.post;
    if (!post || summary.id !== post.id) return;
    const signature = (item) => JSON.stringify([item.revision, item.status, item.deletedAt || null, item.job?.id || null, item.job?.status || null, item.approval?.revision ?? null, item.schedule?.status || null, item.schedule?.at || null, item.publication?.status || null]);
    if (signature(summary) !== signature(post) || (summary.logCount ?? 0) !== (post.agentLog?.length || 0)) { this.reload(); return; }
    if (post.job && summary.job?.phase !== post.job.phase) { post.job.phase = summary.job?.phase; this.renderHeader(post, this.context()); this.renderAgent(post, this.context()); }
  }

  async reload() {
    const post = this.post, generation = this.generation;
    if (!post || this.reloading) return;
    this.reloading = true;
    try { const full = await api(postPath(post.id)); if (generation === this.generation) this.adopt(full); }
    catch (error) { if (generation === this.generation && error.status === 404) this.error("Карточка удалена или перенесена в корзину."); }
    finally { this.reloading = false; }
  }

  settingsChanged() { if (this.post) { this.loadPreview(); this.render(); } }

  onSaved(post) {
    if (!this.post || post.id !== this.post.id || post.revision < this.post.revision) return;
    this.post = post;
    this.render(); this.schedulePreview(); this.onPostChanged(post);
  }

  // A newer card from the server (agent result, upload, restore, another tab). The editor text follows only when nothing local is pending.
  adopt(post) {
    if (!this.post || post.id !== this.post.id || post.revision < this.post.revision) return;
    const previous = this.post;
    this.post = post;
    if (this.autosave.adopt(post)) { this.syncEditorText(post); this.renderFields(post, false); }
    this.render();
    if (post.revision !== previous.revision || !this.preview) this.schedulePreview();
    this.onPostChanged(post);
  }

  syncEditorText(post) {
    const local = readRichText(this.e.text_input);
    if (local.text === (post.text || "") && JSON.stringify(local.entities) === JSON.stringify(canonicalEntities(post.entities || []))) return;
    this.renderText(post, true);
  }

  // --- editing ---
  editable(post = this.post, ctx = this.context()) {
    return Boolean(post) && !ctx.archiveOrigin && ctx.can("edit") && !post.deletedAt && !isPublished(post) && !isScheduled(post) && !["publishing", "uncertain", "working"].includes(post.status);
  }

  onTextInput() {
    if (!this.post || !this.editable()) return;
    const value = readRichText(this.e.text_input);
    this.autosave.edit({ text: value.text, entities: value.entities });
    this.renderInfo(value.text);
  }

  currentText() { return this.autosave.pending.text ?? this.post?.text ?? ""; }

  renderText(post, keepCaret) {
    const input = this.e.text_input, focused = keepCaret && document.activeElement === input;
    const offsets = focused ? selectionOffsets(input) : null;
    renderRichText(input, post.text || "", post.entities || []);
    if (offsets) { const length = (post.text || "").length; restoreSelection(input, Math.min(offsets.start, length), Math.min(offsets.end, length)); }
    this.renderInfo(post.text || "");
  }

  renderFields(post, force) {
    const pending = this.autosave.pending;
    const set = (input, key, value) => { if (force || (document.activeElement !== input && !(key in pending))) input.value = value; };
    set(this.e.title_input, "title", post.title || ""); set(this.e.brief_input, "brief", post.brief || ""); set(this.e.due_at_input, "dueAt", toLocalInput(post.dueAt));
  }

  // «Keep mine» re-sends only the fields this page has not saved yet; everything else is taken from the latest version.
  async resolveConflict(keepMine) {
    if (!this.post) return;
    try {
      const latest = await api(postPath(this.post.id));
      if (keepMine) {
        const fields = { ...this.autosave.pending };
        const post = (await this.autosave.keepMine(latest, fields)) || latest;
        this.post = post;
        if (!("text" in fields)) this.renderText(post, true);
        this.renderFields(post, false); this.render(); this.schedulePreview(); this.onPostChanged(post);
        this.notice("Ваши несохранённые правки записаны поверх новой версии.");
      } else {
        this.autosave.discard(latest); this.post = latest; this.renderText(latest, false); this.renderFields(latest, true); this.render(); this.schedulePreview(); this.onPostChanged(latest); this.notice("Показана версия из другого места.");
      }
    } catch (error) { this.error(error.message); }
  }

  // --- links ---
  openLink(offsets, link) {
    let { start, end } = offsets;
    if (start === end) {
      if (!link) { this.error("Выделите текст, на который нужно поставить ссылку."); return; }
      start = link.offset; end = link.offset + link.length;
    }
    this.linkRange = { start, end };
    const { e } = this;
    e.link_url.value = link?.url || ""; e.link_remove.hidden = !link; e.link_error.hidden = true;
    e.link_popover.hidden = false; e.link_url.focus(); e.link_url.select();
  }

  applyLink(remove) {
    const range = this.linkRange;
    if (!range) return;
    let url = remove ? "" : this.e.link_url.value.trim();
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (!remove && (!url || !safeLinkUrl(url))) { this.e.link_error.textContent = "Нужен адрес вида https://example.com"; this.e.link_error.hidden = false; return; }
    this.hideLink();
    applyFormat(this.e.text_input, "text_link", range.start, range.end, { url });
    this.onTextInput();
  }

  hideLink() { this.linkRange = null; if (this.e.link_popover) this.e.link_popover.hidden = true; }

  // --- rendering ---
  render() {
    const post = this.post;
    if (!post) return;
    const ctx = this.context();
    this.renderHeader(post, ctx); this.renderBanners(post, ctx); this.renderImage(post, ctx); this.renderEditorState(post, ctx);
    this.renderIssues(); this.renderSources(post); this.renderHistory(post, ctx); this.renderPublication(post); this.renderAgent(post, ctx);
    this.renderSaveState(this.autosave.state);
  }

  publishBlockReason(post, ctx) {
    if (!ctx.can("publish")) return "Для публикации нужна роль владельца или публикатора.";
    if (!String(this.currentText()).trim()) return "Добавьте текст публикации.";
    if (jobRunning(post)) return "Дождитесь завершения работы агента.";
    if (!ctx.settings?.verified) return "Проверьте подключение Telegram в настройках.";
    return "";
  }

  renderHeader(post, ctx) {
    const { e } = this, status = displayStatus(post);
    e.card_title.textContent = ("title" in this.autosave.pending ? this.autosave.pending.title : post.title) || "Без названия";
    e.post_status.dataset.status = status; e.post_status.textContent = STATUS_LABELS[status] || status;
    e.archive_back_button.hidden = !ctx.archiveOrigin;
    const running = jobRunning(post);
    e.agent_indicator.hidden = !running;
    e.agent_indicator.textContent = running ? `Агент: ${post.job.phase || "работает"}` : "";
    const scheduled = isScheduled(post), finished = isPublished(post) || ["publishing", "uncertain"].includes(post.status) || ctx.archiveOrigin || post.deletedAt;
    e.scheduled_state.hidden = !scheduled;
    e.scheduled_state.textContent = scheduled ? `Запланировано на ${formatDate(post.schedule.at)}` : "";
    e.unschedule_button.hidden = !scheduled || finished; e.unschedule_button.disabled = !ctx.can("publish") || this.acting;
    const reason = this.publishBlockReason(post, ctx);
    for (const button of [e.publish_open_button, e.schedule_open_button]) { button.hidden = scheduled || finished; button.disabled = Boolean(reason) || this.acting; button.title = reason; }
  }

  renderBanners(post, ctx) {
    const { e } = this;
    let text = "", action = false;
    if (isScheduled(post)) { text = `Публикация запланирована на ${formatDate(post.schedule.at)}. Пока она в плане, материал только для чтения.`; action = ctx.can("publish"); }
    else if (post.status === "working") text = "Агент пишет текст. Редактор откроется, когда он закончит.";
    else if (isPublished(post)) text = "Материал опубликован. Для новой публикации создайте новую карточку.";
    else if (post.deletedAt) text = "Карточка в корзине.";
    else if (!ctx.can("edit")) text = "У вас доступ только для чтения.";
    e.readonly_banner.hidden = !text; e.readonly_text.textContent = text; e.readonly_action.hidden = !action;
    e.uncertain_panel.hidden = post.status !== "uncertain";
  }

  renderImage(post, ctx) {
    const { e } = this, busy = imageBusy(post), editable = this.editable(post, ctx);
    e.image_preview.replaceChildren();
    if (post.image?.url) { const image = document.createElement("img"); image.src = projectUrl(post.image.url); image.alt = "Картинка поста"; e.image_preview.append(image); }
    else { const empty = document.createElement("span"); empty.textContent = "Картинки пока нет: загрузите свою или попросите агента"; e.image_preview.append(empty); }
    e.image_preview.classList.toggle("drawing", busy);
    e.image_overlay.hidden = !busy;
    e.remove_image_button.hidden = !post.image || !editable; e.remove_image_button.disabled = busy || this.acting;
    renderVariants(e.variants, post, { busy: busy || this.acting, readOnly: !editable, onSelect: (variant) => this.selectVariant(variant), onUpload: (file) => this.uploadImage(file), projectUrl });
  }

  renderEditorState(post, ctx) {
    const editable = this.editable(post, ctx);
    this.e.text_input.contentEditable = String(editable);
    for (const button of this.e.format_toolbar.querySelectorAll("button")) button.disabled = !editable;
    for (const input of [this.e.title_input, this.e.brief_input, this.e.due_at_input]) input.disabled = !editable;
    this.renderInfo(this.currentText());
    this.e.convert_links_button.disabled = this.acting;
  }

  renderInfo(text) {
    const length = [...String(text || "")].length, hasImage = Boolean(this.post?.image);
    let layout = "Текста пока нет";
    if (length) {
      if (hasImage && text.length <= 1024) layout = "уйдёт подписью к фото";
      else { const count = messageCount(text); layout = `${hasImage ? "фото и " : ""}${count} ${plural(count, "сообщение", "сообщения", "сообщений")}`; }
    }
    this.e.post_info.textContent = length ? `${length} ${plural(length, "знак", "знака", "знаков")} · ${layout}` : layout;
    this.e.links_notice.hidden = !this.editable() || !hasMarkdownLinks(text);
  }

  schedulePreview() { clearTimeout(this.previewTimer); this.previewTimer = setTimeout(() => this.loadPreview(), 300); }

  async loadPreview() {
    const post = this.post, generation = this.generation;
    if (!post) return;
    try {
      const preview = await api(postPath(post.id, "preview"));
      if (generation !== this.generation || preview.postId !== this.post?.id) return;
      this.preview = preview; this.renderIssues();
    } catch { /* the previous preview stays */ }
  }

  renderIssues() {
    const { e } = this, preview = this.preview, current = preview && preview.revision === this.post?.revision;
    e.preview_issues.replaceChildren(...(current ? preview.issues : []).map((issue) => Object.assign(document.createElement("li"), { textContent: issue })));
    e.destination.textContent = preview?.destination ? `Куда: ${preview.destination}` : "Адресат не настроен";
    e.preview_parts.replaceChildren();
    for (const part of preview?.parts || []) {
      const item = document.createElement("div"); item.className = "preview-part";
      if (part.type === "photo") {
        const image = document.createElement("img"); image.src = projectUrl(part.url); image.alt = "Фото публикации"; item.append(image);
        if (part.caption) { const caption = document.createElement("div"); caption.className = "preview-caption"; renderRichText(caption, part.caption, part.entities, { links: "open" }); item.append(caption); }
      } else { const text = document.createElement("p"); text.className = "preview-text"; renderRichText(text, part.text || "", part.entities, { links: "open" }); item.append(text); }
      e.preview_parts.append(item);
    }
  }

  renderSources(post) {
    const { e } = this, sources = post.sources || [];
    e.sources_count.textContent = sources.length ? `· ${sources.length}` : "";
    e.sources_list.replaceChildren();
    if (!sources.length) { const empty = document.createElement("div"); empty.className = "empty-list"; empty.textContent = "Источники пока не добавлены"; e.sources_list.append(empty); return; }
    for (const source of sources) {
      const item = document.createElement("div"); item.className = "source-item";
      const url = safeHttpUrl(source.url);
      const title = document.createElement(url ? "a" : "strong"); title.textContent = source.title || url || "Источник";
      if (url) { title.href = url; title.target = "_blank"; title.rel = "noopener noreferrer"; }
      const address = document.createElement("span"); address.textContent = source.url || "Ссылка не указана";
      item.append(title, address); e.sources_list.append(item);
    }
  }

  renderHistory(post, ctx) {
    const count = post.history?.length || 0;
    this.e.history_count.textContent = count ? `· ${count + 1}` : "";
    renderHistory(this.e.history_list, post, { projectUrl, userName: ctx.user?.name || "", onOpen: (entry) => this.openVersion(entry) });
  }

  openVersion(entry) {
    const post = this.post, ctx = this.context();
    this.versions.open(entry, post, {
      canRestore: this.editable(post, ctx) && !imageBusy(post) && !this.acting, projectUrl,
      onRestoreAll: (version) => this.restore(version, null),
      onRestoreText: (version) => this.restore(version, ["text"]),
    });
  }

  renderPublication(post) {
    const panel = this.e.publication_panel, publication = post.publication;
    panel.replaceChildren();
    panel.hidden = !publication;
    if (!publication) return;
    const title = document.createElement("h3"); title.textContent = publication.status === "published" ? "Опубликовано в Telegram" : "Результат публикации"; panel.append(title);
    if (publication.error) { const error = document.createElement("p"); error.className = "publication-error"; error.textContent = publication.error; panel.append(error); }
    for (const message of publication.messages || []) {
      const url = safeHttpUrl(message.url), row = document.createElement(url ? "a" : "span");
      if (url) { row.href = url; row.target = "_blank"; row.rel = "noopener noreferrer"; }
      row.textContent = `Сообщение ${message.id}`; panel.append(row);
    }
  }

  renderAgent(post, ctx) {
    const codexBlocked = ctx.codex && (!ctx.codex.available || !ctx.codex.authenticated);
    const running = jobRunning(post);
    let reason = "";
    if (!ctx.can("edit")) reason = "Нет прав на правку.";
    else if (ctx.archiveOrigin || isPublished(post)) reason = "Материал опубликован.";
    else if (isScheduled(post)) reason = "Снимите публикацию с плана, чтобы запускать агента.";
    else if (["publishing", "uncertain"].includes(post.status) || post.deletedAt) reason = "Карточку сейчас нельзя менять.";
    else if (codexBlocked) reason = ctx.codex.message || "Codex недоступен.";
    else if (!running && ctx.agentBusyElsewhere) reason = "Агент занят другой задачей. Дождитесь её завершения.";
    this.agent.show(post, `${ctx.projectId}:${post.id}`, { running, reason, canStop: running && ctx.can("edit") && !this.acting });
  }

  renderSaveState(state) {
    const { e } = this;
    if (!this.post) return;
    const labels = { saved: state.savedAt ? `Сохранено · ${clock(state.savedAt)}` : "Сохранено", dirty: "Сохраняем…", saving: "Сохраняем…", offline: "Не сохранено: нет связи", conflict: "Не сохранено: карточку изменили в другом месте", blocked: `Не сохранено: ${state.error}`, invalid: `Не сохранено: ${state.error}` };
    e.save_indicator.textContent = labels[state.status] || ""; e.save_indicator.dataset.state = state.status;
    e.save_retry.hidden = state.status !== "offline";
    e.conflict_banner.hidden = state.status !== "conflict";
    e.title_input.toggleAttribute("aria-invalid", state.status === "invalid" && /назван/i.test(state.error));
  }

  // --- actions ---
  async act(work, notice = "") {
    if (this.acting) throw new Error("Дождитесь завершения предыдущего действия.");
    this.acting = true; this.clearMessages(); this.render();
    try {
      const post = await work();
      if (post?.id === this.post?.id) this.adopt(post);
      if (notice) this.notice(notice);
      return post;
    } catch (error) { this.error(error.message); throw error; }
    finally { this.acting = false; this.render(); }
  }

  runAgent(request) {
    return this.act(async () => { await this.ensureSaved(); return send(postPath(this.post.id, "jobs"), "POST", { revision: this.post.revision, ...request }); }, "Агент начал работу");
  }
  stopAgent() { return this.act(() => send(postPath(this.post.id, "cancel"), "POST", { revision: this.post.revision }), "Работа агента остановлена").catch(() => {}); }

  async uploadImage(file) {
    try { checkImageFile(file); } catch (error) { this.error(error.message); return; }
    const id = this.post.id;
    await this.act(async () => { await this.ensureSaved(); const dataUrl = await readAsDataUrl(file); if (this.post?.id !== id) throw new Error("Карточка сменилась во время чтения файла."); return send(postPath(id, "image"), "POST", { revision: this.post.revision, dataUrl, name: file.name }); }, "Картинка загружена и добавлена в варианты").catch(() => {});
  }

  removeImage() { return this.act(async () => { await this.ensureSaved(); return send(postPath(this.post.id, "image"), "DELETE", { revision: this.post.revision }); }, "Картинка убрана с поста; она осталась в вариантах").catch(() => {}); }
  selectVariant(variant) { return this.act(async () => { await this.ensureSaved(); return send(postPath(this.post.id, "image/select"), "POST", { revision: this.post.revision, name: variant.name }); }, "Картинка заменена").catch(() => {}); }
  convertLinks() { return this.act(async () => { await this.ensureSaved(); return send(postPath(this.post.id, "links/convert"), "POST", { revision: this.post.revision }); }, "Ссылки преобразованы").catch(() => {}); }
  restore(entry, fields) {
    return this.act(async () => { await this.ensureSaved(); return send(postPath(this.post.id, "restore"), "POST", { revision: this.post.revision, restoreRevision: entry.revision, ...(fields ? { fields } : {}) }); }, fields ? `Текст версии ${entry.revision} возвращён` : `Версия ${entry.revision} возвращена`);
  }
  unschedule() {
    if (!window.confirm("Снять публикацию с плана? После этого материал можно править.")) return;
    this.act(() => send(postPath(this.post.id, "unschedule"), "POST", { revision: this.post.revision }), "Публикация снята с плана").catch(() => {});
  }
  reconcile() {
    const messageIds = this.e.message_ids_input.value.split(/[\s,]+/).filter(Boolean).map(Number);
    if (!messageIds.length || messageIds.some((id) => !Number.isInteger(id) || id <= 0)) { this.error("Введите положительные ID сообщений через запятую."); return; }
    this.act(() => send(postPath(this.post.id, "reconcile"), "POST", { revision: this.post.revision, messageIds }), "Публикация подтверждена по найденным сообщениям").catch(() => {});
  }

  async uploadAttachment(file, postId) {
    checkImageFile(file);
    const dataUrl = await readAsDataUrl(file);
    return send(postPath(postId, "attachments"), "POST", { dataUrl, name: file.name });
  }

  // --- publication ---
  async openPublish(mode, at = null) {
    const post = this.post, ctx = this.context();
    if (!post) return;
    const reason = this.publishBlockReason(post, ctx);
    if (reason) { this.error(reason); return; }
    try { await this.ensureSaved(); this.preview = await api(postPath(post.id, "preview")); this.renderIssues(); }
    catch (error) { this.error(error.message); return; }
    this.shownRevision = this.preview.revision;
    this.publishDialog.open({ post: this.post, preview: this.preview, mode, at, onConfirm: ({ at: when }) => this.publish(when) });
  }

  // Save → fresh preview → approve the current revision if needed → publish now or put on the plan.
  async publish(at) {
    await this.ensureSaved();
    const id = this.post.id, preview = await api(postPath(id, "preview"));
    this.preview = preview; this.renderIssues();
    // Only the version shown in the dialog may go out; if it changed meanwhile, show the new one and ask again.
    if (preview.revision !== this.shownRevision || preview.revision !== this.post.revision) {
      const fresh = preview.revision === this.post.revision ? this.post : await api(postPath(id));
      if (fresh.revision > this.post.revision) this.adopt(fresh);
      this.shownRevision = preview.revision; this.publishDialog.post = this.post; this.publishDialog.render(preview);
      throw new Error("Карточка изменилась, пока был открыт диалог. Проверьте новый вид и подтвердите ещё раз.");
    }
    this.publishDialog.render(preview);
    if (!preview.ready) throw new Error(preview.issues?.[0] || "Публикация пока невозможна.");
    let post = this.post;
    if (post.approval?.revision !== post.revision) post = await send(postPath(id, "approve"), "POST", { revision: post.revision });
    const result = at
      ? await send(postPath(id, "schedule"), "POST", { revision: post.revision, at: at.toISOString(), routeVersion: preview.routeVersion })
      : await send(postPath(id, "publish"), "POST", { revision: post.revision, routeVersion: preview.routeVersion });
    this.adopt(result);
    if (at) this.notice(`Публикация запланирована на ${formatDate(at)}`);
    else if (result.status === "published") this.notice("Публикация подтверждена Telegram");
    else if (result.status === "uncertain") this.error(result.publication?.error || "Результат публикации нужно сверить вручную");
    else if (result.publication?.error) this.error(result.publication.error);
    return result;
  }

  // --- messages ---
  error(message) { this.e.error_banner.textContent = message; this.e.error_banner.hidden = !message; if (message) this.e.notice_banner.hidden = true; }
  notice(message) {
    this.e.notice_banner.textContent = message; this.e.notice_banner.hidden = !message;
    clearTimeout(this.noticeTimer); if (message) this.noticeTimer = setTimeout(() => { this.e.notice_banner.hidden = true; }, 5000);
  }
  clearMessages() { this.e.error_banner.hidden = true; this.e.notice_banner.hidden = true; }
}
