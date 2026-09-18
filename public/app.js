import {renderRichText, readRichText, bindRichEditor} from "./rich-text.js";
"use strict";

const TOPIC_FALLBACK = [{ id: "main", name: "Главная" }];
const STATUS_LABELS = { idea: "Идея", working: "В работе", review: "На проверке", approved: "Согласовано", scheduled: "Запланировано", publishing: "Публикуется", published: "Опубликовано", missed: "Пропущено", failed: "Ошибка", uncertain: "Нужна сверка" };
const MUTATION_HEADERS = { "Content-Type": "application/json", "X-Editor-Request": "editor" };

const state = {
  posts: [], topics: TOPIC_FALLBACK, settings: null, codex: null,
  activeTopic: "main", selectedId: null, selectedPost: null,
  drafts: new Map(), preview: null, loadingPost: false,
  topicRenderKey: "", queueRenderKey: "", initialTopicChosen: false,
  mutationInFlight: false, publishPending: false,
  trash: [], ideaBatches: [], selectedQueueIds: new Set(), selectedIdeaIds: new Set(),
  projects: [], project: null, projectId: new URLSearchParams(location.search).get("project") || localStorage.getItem("editor-project") || "default", requestedPostId: new URLSearchParams(location.search).get("post"), user: null, teamEnabled: false,
  mode: "editor", calendarDate: new Date(), calendarEvents: [], calendarProjects: [], calendarFilter: new Set(), users: [], requestGeneration: 0,
  archiveOrigin: false,
  draftsByProject: new Map(),
  scheduleDrafts: new Map(),
};

const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "topic-nav","settings-state","codex-state","settings-button","members-button","brand-project","project-select","project-button","new-post-button","ideas-button","search-input","status-filter","queue-count","post-list","select-visible","bulk-delete-button","selected-count","trash-button","empty-state","editor-content","post-status","archive-back-button","save-indicator","save-button","job-banner","job-tasks","error-banner","notice-banner","due-at-input","title-input","brief-input","text-input","feedback-input","post-job-button","text-job-button","image-job-button","cancel-job-button","duplicate-panel","duplicate-reason","duplicate-matches","override-reason","sources-list","history-list","image-preview","image-input","remove-image-button","destination","preview-parts","preview-issues","refresh-preview-button","publication-panel","uncertain-panel","message-ids-input","reconcile-button","publish-button","publish-hint","approval-state","schedule-at-input","approve-button","schedule-button","unschedule-button","calendar-title","calendar-prev","calendar-next","calendar-today","calendar-filters","calendar-grid","calendar-agenda","archive-search","archive-list","settings-dialog","settings-form","settings-error","codex-detail","telegram-detail","token-input","destination-type-input","chat-id-input","topic-settings","verify-settings-button","save-settings-button","project-dialog","project-dialog-title","project-name","project-color","project-audience","project-language","project-voice","project-visual-style","project-examples","project-instructions","project-timezone","project-topics","add-project-topic","project-error","new-project-button","save-project-button","team-dialog","team-dialog-title","team-name","team-password","team-error","team-submit","members-dialog","member-list","member-name","member-password","member-role","member-projects","member-create","member-error","new-post-dialog","new-topic","new-title","new-brief","new-post-error","create-post-button","trash-dialog","trash-error","trash-list","history-dialog","history-dialog-title","history-detail","ideas-dialog","ideas-topic","ideas-count","ideas-feedback","ideas-error","ideas-create","ideas-batches"
].map((id) => [id.replaceAll("-", "_"), $(id)]));
elements.backup_button = $("backup-button");
elements.team_logout = $("team-logout"); elements.members_logout = $("members-logout");
elements.schedule_timezone = $("schedule-timezone");

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Editor-Project", state.projectId);
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: "same-origin" });
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (response.status === 401) { openTeamLogin(); throw new Error(payload?.error || "Нужно войти в редакцию"); }
  if (!response.ok) throw new Error(payload?.error || `Ошибка сервера (${response.status})`);
  return payload;
}

function showMessage(element, message = "") {
  element.textContent = message;
  element.hidden = !message;
}

function topicName(topicId) {
  return state.topics.find((topic) => topic.id === topicId)?.name || topicId;
}

function statusPill(status) {
  const pill = document.createElement("span");
  pill.className = "status-pill";
  pill.dataset.status = status;
  pill.textContent = STATUS_LABELS[status] || status;
  return pill;
}

function currentDraft() {
  return state.selectedId ? state.drafts.get(state.selectedId) : null;
}

function hasDirtyDrafts() {
  return [...new Set([...state.draftsByProject.values(), state.drafts])].some((drafts) => [...drafts.values()].some((draft) => draft.dirty));
}

function makeDraft(post) {
  return { title: post.title || "", brief: post.brief || "", text: post.text || "", entities: post.entities || [], topic: post.topic || "main", assignedTo: post.assignedTo || "", dueAt: toLocalInput(post.dueAt), revision: post.revision, dirty: false };
}

function can(action) {
  if (!state.teamEnabled) return true;
  const role = state.user?.role;
  if (role === "owner") return action !== "admin" || state.user?.projectIds?.includes("*");
  if (action === "read") return Boolean(role);
  if (action === "edit") return ["editor", "publisher"].includes(role);
  if (action === "publish") return role === "publisher";
  return false;
}

function toLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function isBusy(post = state.selectedPost) {
  return ["running", "working"].includes(post?.job?.status);
}

function isPublished(post) {
  return post?.status === "published" && post?.publication?.status === "published";
}

function displayStatus(post) {
  return post?.status === "published" && post?.publication?.status && post.publication.status !== "published" ? post.publication.status : post?.status;
}

function isLocked(post = state.selectedPost) {
  return state.publishPending || state.mutationInFlight || isBusy(post) || isPublished(post) || ["publishing", "uncertain"].includes(post?.status);
}

function canTrash(post) {
  return can("edit") && ["idea", "review"].includes(post?.status) && !isBusy(post) && !state.mutationInFlight;
}

function renderMutationLock() {
  state.queueRenderKey = "";
  renderQueue();
  if (state.selectedPost) renderEditor();
  if (elements.trash_dialog.open) renderTrash();
  if (elements.ideas_dialog.open) renderIdeaBatches();
}

function visiblePosts() {
  const search = elements.search_input.value.trim().toLocaleLowerCase("ru");
  const status = elements.status_filter.value;
  return state.posts.filter((post) => post.topic === state.activeTopic)
    .filter((post) => !isPublished(post))
    .filter((post) => !status || post.status === status)
    .filter((post) => !search || `${post.title} ${post.brief}`.toLocaleLowerCase("ru").includes(search));
}

function renderTopics() {
  const renderKey = JSON.stringify([state.activeTopic, state.topics.map(({ id, name }) => [id, name])]);
  if (renderKey === state.topicRenderKey) return;
  state.topicRenderKey = renderKey;
  elements.topic_nav.replaceChildren();
  for (const topic of state.topics) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `topic-button${topic.id === state.activeTopic ? " active" : ""}`;
    button.textContent = topic.name;
    button.addEventListener("click", () => { state.activeTopic = topic.id; renderTopics(); renderQueue(); });
    elements.topic_nav.append(button);
  }
}

function renderQueue() {
  const search = elements.search_input.value.trim().toLocaleLowerCase("ru");
  const status = elements.status_filter.value;
  const posts = visiblePosts();
  const renderKey = JSON.stringify([state.activeTopic, state.selectedId, search, status, [...state.selectedQueueIds], posts.map(({ id, revision, status: postStatus, title, brief }) => [id, revision, postStatus, title, brief])]);
  if (renderKey === state.queueRenderKey) return;
  state.queueRenderKey = renderKey;
  elements.queue_count.textContent = `${posts.length} ${plural(posts.length, "материал", "материала", "материалов")}`;
  const eligible = posts.filter(canTrash);
  const selected = eligible.filter((post) => state.selectedQueueIds.has(post.id));
  elements.select_visible.checked = eligible.length > 0 && selected.length === eligible.length;
  elements.select_visible.indeterminate = selected.length > 0 && selected.length < eligible.length;
  elements.select_visible.disabled = eligible.length === 0;
  elements.selected_count.textContent = String(selected.length); elements.bulk_delete_button.hidden = selected.length === 0;
  elements.post_list.replaceChildren();
  if (!posts.length) {
    const empty = document.createElement("div"); empty.className = "empty-list"; empty.textContent = "В этой выборке пока ничего нет"; elements.post_list.append(empty); return;
  }
  for (const post of posts) {
    const row = document.createElement("div"); row.className = "post-card-row"; row.setAttribute("role", "listitem");
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.className = "post-select"; checkbox.checked = state.selectedQueueIds.has(post.id); checkbox.disabled = !canTrash(post); checkbox.setAttribute("aria-label", `Выбрать ${post.title || "материал"}`);
    checkbox.addEventListener("change", () => { checkbox.checked ? state.selectedQueueIds.add(post.id) : state.selectedQueueIds.delete(post.id); state.queueRenderKey = ""; renderQueue(); });
    const button = document.createElement("button");
    button.type = "button"; button.className = `post-card${post.id === state.selectedId ? " active" : ""}`;
    const top = document.createElement("div"); top.className = "post-card-top";
    const title = document.createElement("strong"); title.textContent = post.title || "Без названия";
    top.append(title, statusPill(displayStatus(post)));
    const brief = document.createElement("p"); brief.textContent = post.brief || "Задание не заполнено";
    button.append(top, brief);
    button.addEventListener("click", () => { state.archiveOrigin = false; selectPost(post.id); });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "card-delete"; remove.textContent = "×"; remove.title = "Переместить в корзину"; remove.setAttribute("aria-label", `Переместить ${post.title || "материал"} в корзину`); remove.disabled = !canTrash(post); remove.addEventListener("click", () => trashPosts([post]));
    row.append(checkbox, button, remove); elements.post_list.append(row);
  }
}

function plural(number, one, few, many) {
  const mod10 = number % 10, mod100 = number % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

async function selectPost(id) {
  if (state.selectedId === id && state.selectedPost) { renderQueue(); renderEditor(); return; }
  state.selectedId = id; state.selectedPost = null; state.preview = null; state.loadingPost = true; renderQueue(); renderPreview();
  elements.empty_state.hidden = true; elements.editor_content.hidden = false;
  showMessage(elements.error_banner, ""); showMessage(elements.notice_banner, "");
  const generation = state.requestGeneration;
  try {
    const post = await api(`/posts/${encodeURIComponent(id)}`);
    if (generation !== state.requestGeneration || state.selectedId !== id) return;
    state.selectedPost = post;
    if (!state.drafts.has(id)) state.drafts.set(id, makeDraft(post));
    renderEditor();
    await loadPreview();
  } catch (error) {
    showMessage(elements.error_banner, error.message);
  } finally { state.loadingPost = false; }
}

function renderEditor() {
  const post = state.selectedPost, draft = currentDraft();
  if (!post || !draft) return;
  const status = displayStatus(post);
  elements.post_status.className = "status-pill";
  elements.post_status.dataset.status = status;
  elements.post_status.textContent = STATUS_LABELS[status] || status;
  elements.title_input.value = draft.title; elements.brief_input.value = draft.brief; renderRichText(elements.text_input, draft.text, draft.entities);
  elements.due_at_input.value = draft.dueAt;
  const readOnly = state.archiveOrigin || isLocked(post) || !can("edit");
  elements.title_input.disabled = readOnly;
  elements.brief_input.disabled = readOnly;
  elements.text_input.contentEditable = String(!readOnly);
  document.querySelectorAll(".format-toolbar button").forEach(button => { button.disabled = readOnly; });
  elements.due_at_input.disabled = readOnly;
  elements.feedback_input.disabled = isLocked(post);
  elements.save_indicator.textContent = draft.dirty ? "Есть несохранённые правки" : `Версия ${post.revision} сохранена`;
  elements.save_indicator.classList.toggle("dirty", draft.dirty);
  elements.save_button.disabled = !draft.dirty || isLocked(post);
  elements.archive_back_button.hidden = !state.archiveOrigin;
  renderJob(post); renderDuplicate(post); renderSources(post.sources || []); renderHistory(post.history || []); renderImage(post.image); renderPublication(post.publication); renderUncertain(post); renderApproval(post); updatePublishState();
}

function scheduleDraftKey(post = state.selectedPost) { return `${state.projectId}:${post?.id || ""}`; }

function renderApproval(post, preserveInput = false) {
  const scheduledAt = post.status === "scheduled" && post.schedule?.status === "scheduled" ? post.schedule.at : null;
  const approvedRevision = post.approval?.revision;
  elements.approval_state.textContent = scheduledAt ? `Запланировано на ${formatDate(scheduledAt)} · версия ${approvedRevision || post.revision}` : approvedRevision === post.revision ? `Версия ${post.revision} согласована` : "Текущая версия ещё не согласована";
  elements.schedule_timezone.textContent = `Дата и время по вашему компьютеру: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  const key = scheduleDraftKey(post);
  if (!preserveInput) elements.schedule_at_input.value = state.scheduleDrafts.get(key) || toLocalInput(scheduledAt) || "";
  const readOnly = state.archiveOrigin || isPublished(post);
  elements.approve_button.disabled = readOnly || !can("publish") || currentDraft()?.dirty || isBusy(post) || approvedRevision === post.revision;
  elements.schedule_button.disabled = readOnly || !can("publish") || currentDraft()?.dirty || approvedRevision !== post.revision || !elements.schedule_at_input.value;
  elements.unschedule_button.hidden = !scheduledAt; elements.unschedule_button.disabled = readOnly || !can("publish") || currentDraft()?.dirty;
}

function renderJob(post) {
  const job = post.job || {};
  const running = isBusy(post);
  const failed = ["failed", "error"].includes(job.status), blocked = job.status === "blocked";
  const tasks = job.kind === "post" ? job.tasks || {} : {};
  const taskFailed = Object.values(tasks).some((task) => ["failed", "error"].includes(task?.status));
  elements.job_banner.hidden = !running && !failed && !blocked && !taskFailed;
  elements.job_banner.classList.toggle("failed", failed || blocked || taskFailed);
  if (running) elements.job_banner.textContent = job.kind === "post" ? `Генерируем пост · ${jobTasksSummary(tasks)}` : jobText(job);
  else if (blocked) elements.job_banner.textContent = post.duplicateCheck?.reason || job.error || "Найден похожий материал";
  else if (failed || taskFailed) elements.job_banner.textContent = job.kind === "post" ? `Генерация завершилась частично · ${jobTasksSummary(tasks)}` : job.error || "Агент не завершил задачу";
  else elements.job_banner.textContent = "";
  renderJobTasks(job);
  elements.cancel_job_button.hidden = !running;
  const codexBlocked = state.codex && (!state.codex.available || !state.codex.authenticated);
  const ideaBusy = state.ideaBatches.some((batch) => batch.status === "running");
  const draft = currentDraft();
  elements.post_job_button.disabled = isLocked(post) || codexBlocked || ideaBusy || draft?.dirty;
  elements.text_job_button.textContent = "Доработать текст";
  const locked = isLocked(post);
  elements.text_job_button.disabled = locked || codexBlocked || ideaBusy || draft?.dirty;
  elements.image_job_button.disabled = locked || codexBlocked || ideaBusy || !post.text?.trim() || draft?.dirty;
}

const JOB_TASK_LABELS = { text: "Текст", image: "Картинка" };
const JOB_STATUS_LABELS = { pending: "Ожидает", queued: "Ожидает", running: "В работе", working: "В работе", completed: "Готово", succeeded: "Готово", success: "Готово", failed: "Ошибка", error: "Ошибка", cancelled: "Остановлено", canceled: "Остановлено" };

function taskStatusLabel(task = {}) {
  return JOB_STATUS_LABELS[task.status] || task.phase || "Ожидает";
}

function jobTasksSummary(tasks = {}) {
  return ["text", "image"].map((key) => `${JOB_TASK_LABELS[key].toLocaleLowerCase("ru-RU")}: ${taskStatusLabel(tasks[key])}`).join(" · ");
}

function renderJobTasks(job = {}) {
  const tasks = job.kind === "post" ? job.tasks || {} : {};
  elements.job_tasks.hidden = !Object.keys(tasks).length;
  elements.job_tasks.replaceChildren();
  for (const key of ["text", "image"]) {
    if (!tasks[key]) continue;
    const row = document.createElement("div"); row.className = "job-task"; row.dataset.status = tasks[key].status || "pending";
    const label = document.createElement("strong"); label.textContent = JOB_TASK_LABELS[key];
    const status = document.createElement("span"); status.textContent = taskStatusLabel(tasks[key]);
    row.append(label, status);
    if (tasks[key].phase && !["completed", "succeeded", "success", "failed", "error"].includes(tasks[key].status)) { const phase = document.createElement("small"); phase.textContent = tasks[key].phase; row.append(phase); }
    if (tasks[key].error) { const error = document.createElement("small"); error.className = "job-task-error"; error.textContent = tasks[key].error; row.append(error); }
    elements.job_tasks.append(row);
  }
}

function jobText(job) {
  const kind = job.kind === "image" ? "изображением" : "текстом";
  return `Агент работает над ${kind}${job.phase ? ` · ${job.phase}` : ""}`;
}

function renderDuplicate(post) {
  const check = post.duplicateCheck;
  elements.duplicate_panel.hidden = !check?.matches?.length && post.job?.status !== "blocked";
  elements.duplicate_reason.textContent = check?.reason || "Перед повторным запуском укажите, чем новый материал будет отличаться.";
  elements.duplicate_matches.replaceChildren();
  for (const match of check?.matches || []) {
    const row = document.createElement("div"); row.className = "duplicate-match";
    const url = safeHttpUrl(match.url); const title = url ? document.createElement("a") : document.createElement("span");
    if (url) { title.href = url; title.target = "_blank"; title.rel = "noopener noreferrer"; }
    title.textContent = match.title || match.id; row.append(title); elements.duplicate_matches.append(row);
  }
  if (document.activeElement !== elements.override_reason) elements.override_reason.value = check?.overrideReason || "";
}

function renderSources(sources) {
  elements.sources_list.replaceChildren();
  if (!sources.length) { const empty = document.createElement("div"); empty.className = "empty-list"; empty.textContent = "Источники пока не добавлены"; elements.sources_list.append(empty); return; }
  for (const source of sources) {
    const item = document.createElement("div"); item.className = "source-item";
    const safeUrl = safeHttpUrl(source.url);
    if (safeUrl) { const link = document.createElement("a"); link.href = safeUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = source.title || safeUrl; item.append(link); }
    else { const title = document.createElement("strong"); title.textContent = source.title || "Источник"; item.append(title); }
    const url = document.createElement("span"); url.textContent = source.url || "Ссылка не указана"; item.append(url); elements.sources_list.append(item);
  }
}

function safeHttpUrl(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}

function safeViewUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, window.location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function projectUrl(value) {
  const safe = safeViewUrl(value);
  if (!safe) return value;
  const url = new URL(safe);
  if (url.origin === window.location.origin) url.searchParams.set("project", state.projectId);
  return url.href;
}

function renderHistory(history) {
  elements.history_list.replaceChildren();
  if (!history.length) { const empty = document.createElement("div"); empty.className = "empty-list"; empty.textContent = "Предыдущих версий нет"; elements.history_list.append(empty); return; }
  [...history].reverse().forEach((version) => {
    const item = document.createElement("div"); item.className = "history-item";
    const meta = document.createElement("div"); const title = document.createElement("strong"); title.textContent = `Версия ${version.revision}`;
    const date = document.createElement("span"); date.textContent = formatDate(version.savedAt); meta.append(title, date);
    const actions = document.createElement("div"); actions.className = "history-actions";
    const view = document.createElement("button"); view.type = "button"; view.className = "text-button neutral"; view.textContent = "Посмотреть"; view.addEventListener("click", () => openHistoryVersion(version));
    const compare = document.createElement("button"); compare.type = "button"; compare.className = "text-button neutral"; compare.textContent = "Сравнить"; compare.addEventListener("click", () => openVersionComparison(version));
    const restore = document.createElement("button"); restore.type = "button"; restore.className = "text-button"; restore.textContent = "Восстановить"; restore.disabled = isLocked();
    restore.addEventListener("click", () => restoreVersion(version.revision)); actions.append(view, compare, restore); item.append(meta, actions); elements.history_list.append(item);
  });
}

function openVersionComparison(version) {
  const current = state.selectedPost || {}, fields = [["Название", version.title, current.title], ["Задание", version.brief, current.brief], ["Текст", version.text, current.text]];
  elements.history_dialog_title.textContent = `Версия ${version.revision} ↔ текущая`;
  elements.history_detail.replaceChildren(...fields.map(([label, before, after]) => { const section = document.createElement("section"); section.className = "comparison-block"; const heading = document.createElement("strong"); heading.textContent = label; const columns = document.createElement("div"); columns.className = "comparison-columns"; for (const [caption, value] of [[`Версия ${version.revision}`, before], [`Версия ${current.revision}`, after]]) { const column = document.createElement("div"); const title = document.createElement("small"); title.textContent = caption; const text = document.createElement("p"); text.textContent = value || "Не указано"; if ((before || "") !== (after || "")) column.className = caption.startsWith(`Версия ${version.revision}`) ? "removed" : "added"; column.append(title, text); columns.append(column); } section.append(heading, columns); return section; })); elements.history_dialog.showModal();
}

function openHistoryVersion(version) {
  elements.history_dialog_title.textContent = `Версия ${version.revision}`;
  elements.history_detail.replaceChildren();
  const fields = [["Дата", formatDate(version.savedAt)], ["Название", version.title], ["Задание", version.brief], ["Текст", version.text]];
  for (const [label, value] of fields) { const block = document.createElement("section"); const heading = document.createElement("strong"); heading.textContent = label; const content = document.createElement("p"); if (label === "Текст") renderRichText(content, value || "", version.entities || []); else content.textContent = value || "Не указано"; block.append(heading, content); elements.history_detail.append(block); }
  const imageBlock = document.createElement("section"); const imageHeading = document.createElement("strong"); imageHeading.textContent = "Изображение"; imageBlock.append(imageHeading);
  const imageUrl = safeViewUrl(version.image?.url);
  if (imageUrl) {
    if (new URL(imageUrl).origin === window.location.origin) { const image = document.createElement("img"); image.className = "version-image"; image.src = imageUrl; image.alt = version.image?.name ? `Изображение версии: ${version.image.name}` : "Изображение версии"; imageBlock.append(image); }
    const link = document.createElement("a"); link.href = imageUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = version.image?.name ? `Открыть ${version.image.name}` : "Открыть изображение"; imageBlock.append(link);
  } else { const empty = document.createElement("p"); empty.textContent = "Не добавлено"; imageBlock.append(empty); }
  elements.history_detail.append(imageBlock);
  const sources = document.createElement("section"); const heading = document.createElement("strong"); heading.textContent = "Источники"; sources.append(heading);
  if (!(version.sources || []).length) { const text = document.createElement("p"); text.textContent = "Не указаны"; sources.append(text); }
  for (const source of version.sources || []) { const text = document.createElement("p"); text.textContent = `${source.title || "Источник"}${source.url ? ` — ${source.url}` : ""}`; sources.append(text); }
  elements.history_detail.append(sources); elements.history_dialog.showModal();
}

function formatDate(value) {
  if (!value) return "Дата не указана";
  const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function formatPublicationDate(value) {
  if (!value) return "Дата публикации не указана";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.valueOf()) ? "Дата публикации не указана" : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short" }).format(date);
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Дата публикации не указана" : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function renderImage(image) {
  elements.image_preview.replaceChildren();
  if (image?.url) { const img = document.createElement("img"); img.src = projectUrl(image.url); img.alt = image.name ? `Изображение: ${image.name}` : "Изображение публикации"; elements.image_preview.append(img); }
  else { const label = document.createElement("span"); label.textContent = "Изображение не добавлено"; elements.image_preview.append(label); }
  const locked = isLocked() || currentDraft()?.dirty;
  elements.remove_image_button.hidden = !image; elements.remove_image_button.disabled = locked; elements.image_input.disabled = locked;
}

function renderPublication(publication) {
  elements.publication_panel.replaceChildren();
  if (!publication) { elements.publication_panel.hidden = true; return; }
  elements.publication_panel.hidden = false;
  const title = document.createElement("h3");
  title.textContent = publication.status === "published" ? "Опубликовано в Telegram" : "Результат публикации";
  elements.publication_panel.append(title);
  if (publication.error) { const error = document.createElement("p"); error.className = "publication-error"; error.textContent = publication.error; elements.publication_panel.append(error); }
  for (const message of publication.messages || []) {
    const safeUrl = safeHttpUrl(message.url);
    const row = safeUrl ? document.createElement("a") : document.createElement("span");
    if (safeUrl) { row.href = safeUrl; row.target = "_blank"; row.rel = "noopener noreferrer"; }
    row.textContent = `Сообщение ${message.id}`;
    elements.publication_panel.append(row);
  }
}

function renderUncertain(post) {
  elements.uncertain_panel.hidden = post.status !== "uncertain";
}

function markDirty() {
  const draft = currentDraft(); if (!draft) return;
  draft.title = elements.title_input.value; draft.brief = elements.brief_input.value; Object.assign(draft, readRichText(elements.text_input)); draft.dueAt = elements.due_at_input.value; draft.dirty = true;
  elements.preview_parts.closest("details").hidden = true;
  renderQueue(); renderJob(state.selectedPost); renderImage(state.selectedPost.image); updatePublishState();
  renderApproval(state.selectedPost, true);
  elements.save_indicator.textContent = "Есть несохранённые правки"; elements.save_indicator.classList.add("dirty"); elements.save_button.disabled = isLocked();
}

async function savePost() {
  const draft = currentDraft(); if (!draft || !draft.dirty) return state.selectedPost;
  return mutateSelected(`/posts/${encodeURIComponent(state.selectedId)}`, "PATCH", { revision: draft.revision, title: draft.title, brief: draft.brief, text: draft.text, entities: draft.entities, topic: draft.topic, assignedTo: draft.assignedTo || null, dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : null }, "Правки сохранены");
}

async function mutateSelected(path, method, body, successMessage = "") {
  const selectedId = state.selectedId, generation = state.requestGeneration;
  state.mutationInFlight = true;
  if (state.selectedPost) renderEditor();
  showMessage(elements.error_banner, "");
  try {
    const post = await api(path, { method, headers: MUTATION_HEADERS, body: JSON.stringify(body) });
    if (generation !== state.requestGeneration || state.selectedId !== selectedId) return post;
    adoptPost(post); if (successMessage) showMessage(elements.notice_banner, successMessage); return post;
  } catch (error) { showMessage(elements.error_banner, error.message); throw error; }
  finally { state.mutationInFlight = false; state.queueRenderKey = ""; renderQueue(); if (state.selectedPost) renderEditor(); }
}

function adoptPost(post) {
  state.selectedPost = post;
  state.preview = null;
  state.posts = state.posts.map((item) => item.id === post.id ? post : item);
  state.drafts.set(post.id, makeDraft(post));
  renderQueue(); renderEditor(); loadPreview();
}

async function startJob(kind) {
  const draft = currentDraft(); if (!draft || draft.dirty) { showMessage(elements.error_banner, "Сначала сохраните правки."); return; }
  try { await mutateSelected(`/posts/${encodeURIComponent(state.selectedId)}/jobs`, "POST", { revision: state.selectedPost.revision, kind, feedback: elements.feedback_input.value.trim(), overrideReason: elements.override_reason.value.trim() }, "Агент начал работу"); }
  catch { /* error shown */ }
}

async function cancelJob() {
  try { await mutateSelected(`/posts/${encodeURIComponent(state.selectedId)}/cancel`, "POST", { revision: state.selectedPost.revision }, "Работа агента остановлена"); }
  catch { /* error shown */ }
}

async function restoreVersion(restoreRevision) {
  const draft = currentDraft();
  if (draft?.dirty && !window.confirm("Несохранённые правки будут заменены выбранной версией. Продолжить?")) return;
  try { await mutateSelected(`/posts/${encodeURIComponent(state.selectedId)}/restore`, "POST", { revision: state.selectedPost.revision, restoreRevision }, `Версия ${restoreRevision} восстановлена как новая`); }
  catch { /* error shown */ }
}

async function loadPreview() {
  if (!state.selectedId || !state.selectedPost) return;
  const expected = { postId: state.selectedPost.id, revision: state.selectedPost.revision, routeVersion: state.settings?.routeVersion, generation: state.requestGeneration };
  try {
    const preview = await api(`/posts/${encodeURIComponent(expected.postId)}/preview`);
    const matches = state.requestGeneration === expected.generation && state.selectedPost?.id === expected.postId && state.selectedPost.revision === expected.revision && state.settings?.routeVersion === expected.routeVersion && preview.postId === expected.postId && preview.revision === expected.revision && preview.routeVersion === expected.routeVersion;
    if (matches) { state.preview = preview; renderPreview(); }
  }
  catch (error) { if (state.selectedId === expected.postId) { state.preview = null; renderPreview(); showMessage(elements.error_banner, error.message); } }
}

function renderPreview() {
  const preview = state.preview;
  elements.preview_parts.closest("details").hidden = Boolean(currentDraft()?.dirty);
  elements.preview_parts.replaceChildren(); elements.preview_issues.replaceChildren();
  elements.destination.textContent = preview?.destination || "Адресат не настроен";
  if (!preview?.parts?.length) { const empty = document.createElement("div"); empty.className = "empty-list"; empty.textContent = "Предпросмотр пока недоступен"; elements.preview_parts.append(empty); }
  else for (const part of preview.parts) {
    const item = document.createElement("div"); item.className = "preview-part";
    if (part.type === "photo") { const img = document.createElement("img"); img.src = projectUrl(part.url); img.alt = "Фото публикации"; item.append(img); if (part.caption) { const caption = document.createElement("div"); caption.className = "preview-caption"; renderRichText(caption, part.caption, part.entities); item.append(caption); } }
    else { const text = document.createElement("p"); text.className = "preview-text"; renderRichText(text, part.text || "", part.entities); item.append(text); }
    elements.preview_parts.append(item);
  }
  for (const issue of preview?.issues || []) { const li = document.createElement("li"); li.textContent = issue; elements.preview_issues.append(li); }
  updatePublishState();
}

function previewMatchesCurrent() {
  return state.preview?.postId === state.selectedPost?.id && state.preview?.revision === state.selectedPost?.revision && state.preview?.routeVersion === state.settings?.routeVersion;
}

function publishBlockReason() {
  const post = state.selectedPost, draft = currentDraft();
  if (!post || !draft) return "Выберите материал";

  if (!draft.text.trim()) return "Добавьте текст публикации";
  if (isBusy(post)) return "Дождитесь завершения работы агента";
  if (isPublished(post)) return "Материал уже опубликован";
  if (post.status === "publishing") return "Публикация уже выполняется";
  if (post.status === "uncertain") return "Сначала сверьте результат в Telegram";
  if (!state.settings?.verified) return "Проверьте подключение Telegram в настройках";
  if (!draft.dirty && !previewMatchesCurrent()) return "Обновите предпросмотр этой версии";
  if (!draft.dirty && !state.preview?.ready) return state.preview?.issues?.[0] || "Предпросмотр ещё не готов";
  return "";
}

function updatePublishState() {
  const reason = publishBlockReason(); elements.publish_button.disabled = Boolean(reason) || state.publishPending || state.mutationInFlight || !can("publish"); elements.publish_hint.textContent = !can("publish") ? "Для публикации нужна роль владельца или публикатора." : reason || "Будет отправлена именно показанная выше версия и адресат.";
}

async function publishPost() {
  const reason = publishBlockReason(); if (reason || state.publishPending || state.mutationInFlight) return;
  state.publishPending = true; renderEditor();
  elements.publish_button.disabled = true;
  try {
    const selectedId = state.selectedId, generation = state.requestGeneration;
    if (currentDraft()?.dirty) await savePost();
    if (selectedId !== state.selectedId || generation !== state.requestGeneration) return;
    await loadPreview();
    if (selectedId !== state.selectedId || generation !== state.requestGeneration || publishBlockReason()) return;
    const post = await mutateSelected(`/posts/${encodeURIComponent(state.selectedId)}/publish`, "POST", { revision: state.preview.revision, routeVersion: state.preview.routeVersion });
    if (post.status === "published") showMessage(elements.notice_banner, "Публикация подтверждена Telegram");
    else if (post.status === "uncertain") showMessage(elements.error_banner, post.publication?.error || "Результат публикации нужно сверить вручную");
    else if (post.publication?.error) showMessage(elements.error_banner, post.publication.error);
  }
  catch { /* error is shown by save or publish */ }
  finally { state.publishPending = false; renderEditor(); updatePublishState(); }
}

async function reconcilePost() {
  const messageIds = elements.message_ids_input.value.split(/[\s,]+/).filter(Boolean).map(Number);
  if (!messageIds.length || messageIds.some((id) => !Number.isInteger(id) || id <= 0)) { showMessage(elements.error_banner, "Введите положительные ID сообщений через запятую."); return; }
  try { await mutateSelected(`/posts/${encodeURIComponent(state.selectedId)}/reconcile`, "POST", { revision: state.selectedPost.revision, messageIds }, "Публикация подтверждена по найденным сообщениям"); }
  catch { /* error shown */ }
}

async function uploadImage(file) {
  if (!file) return;
  if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) { showMessage(elements.error_banner, "Подойдёт PNG, JPEG или WebP размером до 8 МБ."); return; }
  const target = { id: state.selectedId, revision: state.selectedPost?.revision, projectId: state.projectId, generation: state.requestGeneration };
  if (currentDraft()?.dirty) { showMessage(elements.error_banner, "Сначала сохраните правки."); elements.image_input.value = ""; return; }
  try {
    const dataUrl = await readAsDataUrl(file);
    if (state.projectId !== target.projectId || state.requestGeneration !== target.generation || state.selectedId !== target.id || state.selectedPost?.revision !== target.revision) { showMessage(elements.error_banner, "Проект или карточка изменились во время чтения файла. Выберите изображение ещё раз."); return; }
    await mutateSelected(`/posts/${encodeURIComponent(target.id)}/image`, "POST", { revision: target.revision, dataUrl, name: file.name }, "Изображение загружено");
  }
  catch (error) { if (!elements.error_banner.textContent) showMessage(elements.error_banner, error.message); }
  finally { elements.image_input.value = ""; }
}

function readAsDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("Не удалось прочитать файл")); reader.readAsDataURL(file); }); }

async function removeImage() {
  try { await mutateSelected(`/posts/${encodeURIComponent(state.selectedId)}/image`, "DELETE", { revision: state.selectedPost.revision }, "Изображение удалено"); }
  catch { /* error shown */ }
}

function renderSettings() {
  const settings = state.settings || { tokenConfigured: false, chatId: "", topics: {}, verified: false };
  elements.settings_state.textContent = settings.verified ? "Telegram готов" : "Нужна настройка";
  elements.telegram_detail.textContent = settings.verified ? `Подключён${settings.botName ? ` · ${settings.botName}` : ""}` : settings.tokenConfigured ? "Сохранён, требуется проверка" : "Не подключён";
  elements.chat_id_input.value = settings.chatId || ""; elements.token_input.value = ""; elements.destination_type_input.value = settings.destinationType || "forum";
  elements.topic_settings.closest("fieldset").hidden = elements.destination_type_input.value === "channel";
  elements.topic_settings.replaceChildren();
  for (const topic of state.topics) {
    const label = document.createElement("label"); label.className = "field";
    const span = document.createElement("span"); span.textContent = topic.name;
    const input = document.createElement("input"); input.dataset.topic = topic.id; input.placeholder = "ID или ссылка t.me/c/…"; input.value = settings.topics?.[topic.id] || "";
    label.append(span, input); elements.topic_settings.append(label);
  }
  renderCodex(); updatePublishState();
}

function renderCodex() {
  const codex = state.codex;
  const text = !codex ? "Проверяем…" : codex.available && codex.authenticated ? `Готов${codex.version ? ` · ${codex.version}` : ""}` : codex.message || "Недоступен";
  elements.codex_state.textContent = text; elements.codex_detail.textContent = text;
  if (state.selectedPost) renderJob(state.selectedPost);
}

async function loadCodex() {
  const projectId = state.projectId, generation = state.requestGeneration;
  try {
    const codex = await api("/codex");
    if (state.projectId !== projectId || state.requestGeneration !== generation) return;
    state.codex = codex;
  } catch {
    if (state.projectId !== projectId || state.requestGeneration !== generation) return;
    state.codex = { available: false, authenticated: false, message: "Проверка недоступна" };
  }
  renderCodex();
}

async function openSettings() {
  const projectId = state.projectId, generation = state.requestGeneration;
  showMessage(elements.settings_error, ""); renderSettings(); elements.settings_dialog.showModal();
  try {
    const [settings, codex] = await Promise.all([api("/settings"), api("/codex")]);
    if (state.projectId !== projectId || state.requestGeneration !== generation) return;
    state.settings = settings; state.codex = codex; renderSettings();
  }
  catch (error) { if (state.projectId === projectId && state.requestGeneration === generation) showMessage(elements.settings_error, error.message); }
}

function settingsPayload() {
  const topics = {};
  elements.topic_settings.querySelectorAll("input[data-topic]").forEach((input) => { topics[input.dataset.topic] = input.value.trim(); });
  return { token: elements.token_input.value.trim(), chatId: elements.chat_id_input.value.trim(), destinationType: elements.destination_type_input.value, topics };
}

async function saveSettings() {
  const projectId = state.projectId, generation = state.requestGeneration;
  showMessage(elements.settings_error, "");
  try {
    const settings = await api("/settings", { method: "PUT", headers: MUTATION_HEADERS, body: JSON.stringify(settingsPayload()) });
    if (state.projectId !== projectId || state.requestGeneration !== generation) return;
    state.settings = settings; renderSettings();
  }
  catch (error) { if (state.projectId === projectId && state.requestGeneration === generation) showMessage(elements.settings_error, error.message); }
}

async function verifySettings() {
  const projectId = state.projectId, generation = state.requestGeneration;
  showMessage(elements.settings_error, ""); elements.verify_settings_button.disabled = true;
  try {
    const settings = await api("/settings/verify", { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify({}) });
    if (state.projectId !== projectId || state.requestGeneration !== generation) return;
    state.settings = settings; renderSettings();
  }
  catch (error) { if (state.projectId === projectId && state.requestGeneration === generation) showMessage(elements.settings_error, error.message); }
  finally { elements.verify_settings_button.disabled = false; }
}

async function downloadBackup() {
  elements.backup_button.disabled = true; showMessage(elements.settings_error, "");
  try {
    const response = await fetch("/api/backup", { headers: { "X-Editor-Project": state.projectId }, credentials: "same-origin" });
    if (!response.ok) { let message = `Ошибка сервера (${response.status})`; try { message = (await response.json()).error || message; } catch { /* archive response */ } throw new Error(message); }
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); const disposition = response.headers.get("content-disposition") || ""; link.download = disposition.match(/filename="?([^";]+)"?/)?.[1] || `editor-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`; link.href = url; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showMessage(elements.settings_error, error.message); }
  finally { elements.backup_button.disabled = false; }
}

function openNewPost() {
  elements.new_topic.replaceChildren();
  for (const topic of state.topics) { const option = document.createElement("option"); option.value = topic.id; option.textContent = topic.name; option.selected = topic.id === state.activeTopic; elements.new_topic.append(option); }
  elements.new_title.value = ""; elements.new_brief.value = ""; showMessage(elements.new_post_error, ""); elements.new_post_dialog.showModal();
}

async function createPost() {
  const title = elements.new_title.value.trim(); if (!title) { showMessage(elements.new_post_error, "Введите название идеи."); return; }
  try {
    const post = await api("/posts", { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify({ topic: elements.new_topic.value, title, brief: elements.new_brief.value.trim() }) });
    state.posts.unshift(post); state.activeTopic = post.topic; elements.new_post_dialog.close(); renderTopics(); renderQueue(); await selectPost(post.id);
  } catch (error) { showMessage(elements.new_post_error, error.message); }
}

async function trashPosts(posts) {
  if (!posts.length || posts.some((post) => !canTrash(post))) return;
  const dirty = posts.filter((post) => state.drafts.get(post.id)?.dirty);
  const warning = dirty.length ? " В выбранных карточках есть несохранённые правки: они не попадут в корзину." : "";
  if (!window.confirm(`Переместить ${posts.length} ${plural(posts.length, "материал", "материала", "материалов")} в корзину? Их можно будет восстановить.${warning}`)) return;
  const safePosts = posts.filter((post) => !state.drafts.get(post.id)?.dirty);
  if (!safePosts.length) return;
  state.mutationInFlight = true;
  renderMutationLock();
  try {
    const result = await api("/posts/trash", { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify({ items: safePosts.map(({ id, revision }) => ({ id, revision })) }) });
    const removed = new Set((result.posts || []).map((post) => post.id));
    state.posts = state.posts.filter((post) => !removed.has(post.id)); state.trash = [...(result.posts || []), ...state.trash.filter((post) => !removed.has(post.id))];
    for (const id of removed) { state.selectedQueueIds.delete(id); state.drafts.delete(id); }
    if (removed.has(state.selectedId)) { state.selectedId = null; state.selectedPost = null; elements.editor_content.hidden = true; elements.empty_state.hidden = false; }
    state.queueRenderKey = ""; renderQueue(); renderTrash();
  } catch (error) { showMessage(elements.error_banner, error.message); }
  finally { state.mutationInFlight = false; renderMutationLock(); }
}

function renderTrash() {
  elements.trash_list.replaceChildren();
  if (!state.trash.length) { const empty = document.createElement("div"); empty.className = "empty-list"; empty.textContent = "Корзина пуста"; elements.trash_list.append(empty); return; }
  for (const post of state.trash) {
    const row = document.createElement("div"); row.className = "dialog-row"; const meta = document.createElement("div"); const title = document.createElement("strong"); title.textContent = post.title || "Без названия"; const note = document.createElement("span"); note.textContent = `${topicName(post.topic)} · версия ${post.revision}`; meta.append(title, note);
    const restore = document.createElement("button"); restore.type = "button"; restore.className = "button button-secondary"; restore.textContent = "Восстановить"; restore.disabled = state.mutationInFlight; restore.addEventListener("click", () => untrashPost(post)); row.append(meta, restore); elements.trash_list.append(row);
  }
}

async function untrashPost(post) {
  if (state.mutationInFlight) return;
  state.mutationInFlight = true; renderMutationLock();
  showMessage(elements.trash_error, "");
  try { const restored = await api(`/posts/${encodeURIComponent(post.id)}/untrash`, { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify({ revision: post.revision }) }); state.trash = state.trash.filter((item) => item.id !== post.id); state.posts.unshift(restored); state.queueRenderKey = ""; renderTrash(); renderQueue(); }
  catch (error) { showMessage(elements.trash_error, error.message); }
  finally { state.mutationInFlight = false; renderMutationLock(); }
}

function renderIdeaBatches() {
  elements.ideas_create.disabled = state.mutationInFlight || state.ideaBatches.some((batch) => batch.status === "running") || state.posts.some(isBusy);
  elements.ideas_batches.replaceChildren();
  if (!state.ideaBatches.length) { const empty = document.createElement("div"); empty.className = "empty-list"; empty.textContent = "Истории подборов пока нет"; elements.ideas_batches.append(empty); return; }
  for (const batch of state.ideaBatches) {
    const box = document.createElement("section"); box.className = "idea-batch"; const header = document.createElement("div"); header.className = "batch-header"; const title = document.createElement("strong"); title.textContent = topicName(batch.topic); const status = document.createElement("span"); status.textContent = batch.status === "running" ? batch.phase || "Подбираем…" : batch.status === "completed" ? "Готово" : batch.status === "cancelled" ? "Остановлено" : "Ошибка"; header.append(title, status); box.append(header);
    if (batch.error) { const error = document.createElement("p"); error.className = "inline-error"; error.textContent = batch.error; box.append(error); }
    const choices = document.createElement("div"); choices.className = "idea-choices";
    for (const idea of batch.ideas || []) { const label = document.createElement("label"); label.className = "idea-choice"; const check = document.createElement("input"); check.type = "checkbox"; check.value = idea.id; check.checked = state.selectedIdeaIds.has(idea.id) && !idea.acceptedPostId; check.disabled = Boolean(idea.acceptedPostId); check.addEventListener("change", () => check.checked ? state.selectedIdeaIds.add(idea.id) : state.selectedIdeaIds.delete(idea.id)); const text = document.createElement("span"); const name = document.createElement("strong"); name.textContent = idea.title; const brief = document.createElement("small"); brief.textContent = idea.brief || ""; text.append(name, brief); if (idea.matches?.length) { const warning = document.createElement("em"); warning.textContent = `Похожие: ${idea.matches.map((match) => match.title || match.id).join(", ")}`; text.append(warning); } label.append(check, text); choices.append(label); } box.append(choices);
    if (batch.status === "running") { const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "button button-danger"; cancel.textContent = "Остановить"; cancel.disabled = state.mutationInFlight; cancel.addEventListener("click", () => cancelIdeaBatch(batch.id)); box.append(cancel); }
    if (batch.status === "completed") { const accept = document.createElement("button"); accept.type = "button"; accept.className = "button button-primary"; accept.textContent = "Добавить выбранные"; accept.disabled = state.mutationInFlight; accept.addEventListener("click", () => acceptIdeas(batch.id, choices)); box.append(accept); }
    elements.ideas_batches.append(box);
  }
}

function openIdeas() {
  elements.ideas_topic.replaceChildren(); for (const topic of state.topics) { const option = document.createElement("option"); option.value = topic.id; option.textContent = topic.name; option.selected = topic.id === state.activeTopic; elements.ideas_topic.append(option); } showMessage(elements.ideas_error, ""); renderIdeaBatches(); elements.ideas_dialog.showModal();
}
async function createIdeaBatch() {
  const count = Number(elements.ideas_count.value);
  if (state.mutationInFlight) return;
  if (!Number.isInteger(count) || count < 1 || count > 10) { showMessage(elements.ideas_error, "Укажите от 1 до 10 идей."); return; }
  state.mutationInFlight = true; renderMutationLock();
  try { const batch = await api("/ideas", { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify({ topic: elements.ideas_topic.value, count, feedback: elements.ideas_feedback.value.trim() }) }); state.ideaBatches.unshift(batch); }
  catch (error) { showMessage(elements.ideas_error, error.message); }
  finally { state.mutationInFlight = false; renderMutationLock(); }
}
async function cancelIdeaBatch(id) {
  if (state.mutationInFlight) return;
  state.mutationInFlight = true; renderMutationLock();
  try { const batch = await api(`/ideas/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: MUTATION_HEADERS, body: "{}" }); state.ideaBatches = state.ideaBatches.map((item) => item.id === id ? batch : item); }
  catch (error) { showMessage(elements.ideas_error, error.message); }
  finally { state.mutationInFlight = false; renderMutationLock(); }
}
async function acceptIdeas(id, choices) {
  const selected = [...choices.querySelectorAll("input:checked")].map((input) => input.value);
  if (state.mutationInFlight) return;
  if (!selected.length) { showMessage(elements.ideas_error, "Выберите хотя бы одну идею."); return; }
  state.mutationInFlight = true; renderMutationLock();
  try { const result = await api(`/ideas/${encodeURIComponent(id)}/accept`, { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify({ selected }) }); state.ideaBatches = state.ideaBatches.map((item) => item.id === id ? result.batch : item); selected.forEach((ideaId) => state.selectedIdeaIds.delete(ideaId)); for (const post of result.posts || []) if (!state.posts.some((item) => item.id === post.id)) state.posts.unshift(post); state.queueRenderKey = ""; renderQueue(); }
  catch (error) { showMessage(elements.ideas_error, error.message); }
  finally { state.mutationInFlight = false; renderMutationLock(); }
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-view").forEach((view) => { view.hidden = view.id !== `${mode}-mode`; });
  document.querySelectorAll(".mode-button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  if (mode === "calendar") loadCalendar();
  if (mode === "archive") renderArchive();
}

function setProjectLocation(projectId, clearPost = true) {
  const url = new URL(window.location.href);
  url.searchParams.set("project", projectId);
  if (clearPost) url.searchParams.delete("post");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function rememberProjectDrafts(projectId = state.projectId) {
  state.draftsByProject.set(projectId, state.drafts);
}

function resetProjectWorkspace() {
  state.requestGeneration += 1; state.posts = []; state.trash = []; state.ideaBatches = []; state.selectedId = null; state.selectedPost = null; state.preview = null; state.archiveOrigin = false; state.drafts = state.draftsByProject.get(state.projectId) || new Map(); rememberProjectDrafts(); state.selectedQueueIds.clear(); state.queueRenderKey = ""; state.topicRenderKey = ""; state.initialTopicChosen = false;
  elements.editor_content.hidden = true; elements.empty_state.hidden = false; renderQueue();
}

async function switchProject(projectId) {
  if (!projectId || projectId === state.projectId) return true;
  if ([...state.drafts.values()].some((draft) => draft.dirty) && !window.confirm("Переключить проект? Несохранённые правки останутся в этом проекте до возврата на страницу.")) { elements.project_select.value = state.projectId; return false; }
  rememberProjectDrafts(); state.projectId = projectId; localStorage.setItem("editor-project", projectId); setProjectLocation(projectId); resetProjectWorkspace(); await refreshState(); await loadCodex();
  return true;
}

function renderProjectChrome() {
  elements.project_select.replaceChildren(...state.projects.map((project) => new Option(project.name, project.id, false, project.id === state.projectId)));
  elements.brand_project.textContent = state.project?.name || "локальная";
  document.documentElement.style.setProperty("--project", state.project?.color || "#1e45fb");
  elements.members_button.hidden = false; elements.members_button.title = !state.teamEnabled ? "Настроить команду" : can("admin") ? "Участники" : `Вы вошли как ${state.user?.name || "участник"}`;
  elements.project_button.disabled = state.teamEnabled && state.user?.role !== "owner";
  elements.new_project_button.hidden = state.teamEnabled && !can("admin"); elements.backup_button.disabled = state.teamEnabled && !can("admin");
}

function projectTopicRow(topic = { id: "", name: "" }) {
  const row = document.createElement("div"); row.className = "project-topic-row";
  const id = document.createElement("input"); id.placeholder = "id"; id.value = topic.id || ""; id.dataset.field = "id";
  const name = document.createElement("input"); name.placeholder = "Название"; name.value = topic.name || ""; name.dataset.field = "name";
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "text-button"; remove.textContent = "×"; remove.setAttribute("aria-label", "Удалить тему"); remove.addEventListener("click", () => row.remove()); row.append(id, name, remove); return row;
}

function openProjectDialog(create = false) {
  const project = create ? { name: "", color: "#1e45fb", language: "ru", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, topics: [{ id: "main", name: "Главная" }] } : state.project || {};
  elements.project_dialog.dataset.create = create ? "true" : "false"; elements.project_dialog_title.textContent = create ? "Новый проект" : "Настройки проекта";
  for (const key of ["name", "audience", "language", "voice", "examples", "instructions", "timezone"]) elements[`project_${key}`].value = project[key] || "";
  elements.project_visual_style.value = project.visualStyle || ""; elements.project_color.value = project.color || "#1e45fb"; elements.project_topics.replaceChildren(...(project.topics || []).map(projectTopicRow)); showMessage(elements.project_error, ""); elements.project_dialog.showModal();
}

function projectPayload() {
  const topics = [...elements.project_topics.children].map((row) => ({ id: row.querySelector('[data-field="id"]').value.trim(), name: row.querySelector('[data-field="name"]').value.trim() })).filter((topic) => topic.id || topic.name);
  return { name: elements.project_name.value.trim(), audience: elements.project_audience.value.trim(), language: elements.project_language.value.trim(), voice: elements.project_voice.value.trim(), visualStyle: elements.project_visual_style.value.trim(), examples: elements.project_examples.value.trim(), instructions: elements.project_instructions.value.trim(), timezone: elements.project_timezone.value.trim(), color: elements.project_color.value, topics, ...(!elements.project_dialog.dataset.create || elements.project_dialog.dataset.create === "false" ? { revision: state.project?.revision } : {}) };
}

async function saveProject() {
  try {
    const creating = elements.project_dialog.dataset.create === "true";
    const project = await api(creating ? "/projects" : `/projects/${encodeURIComponent(state.projectId)}`, { method: creating ? "POST" : "PATCH", headers: MUTATION_HEADERS, body: JSON.stringify(projectPayload()) });
    elements.project_dialog.close(); if (creating) { rememberProjectDrafts(); state.projectId = project.id; localStorage.setItem("editor-project", project.id); setProjectLocation(project.id); resetProjectWorkspace(); } await refreshState();
  } catch (error) { showMessage(elements.project_error, error.message); }
}


async function approvePost() { try { await mutateSelected(`/posts/${encodeURIComponent(state.selectedId)}/approve`, "POST", { revision: state.selectedPost.revision }, "Версия согласована"); } catch { /* shown */ } }
async function schedulePost() {
  const at = new Date(elements.schedule_at_input.value); if (Number.isNaN(at.valueOf())) { showMessage(elements.error_banner, "Выберите дату и время публикации."); return; }
  if (!window.confirm(`Запланировать сохранённую версию ${state.selectedPost.revision} на ${formatDate(at)}?`)) return;
  try { await mutateSelected(`/posts/${encodeURIComponent(state.selectedId)}/schedule`, "POST", { revision: state.selectedPost.revision, at: at.toISOString(), routeVersion: state.settings?.routeVersion }, "Публикация запланирована"); state.scheduleDrafts.delete(scheduleDraftKey()); } catch { /* shown */ }
}
async function unschedulePost() { if (currentDraft()?.dirty) { showMessage(elements.error_banner, "Сначала сохраните правки к материалу."); return; } if (!window.confirm("Отменить запланированную публикацию?")) return; try { await mutateSelected(`/posts/${encodeURIComponent(state.selectedId)}/unschedule`, "POST", { revision: state.selectedPost.revision }, "План отменён"); state.scheduleDrafts.delete(scheduleDraftKey()); } catch { /* shown */ } }

async function loadCalendar() {
  const generation = state.requestGeneration;
  try { const data = await api("/calendar"); if (generation !== state.requestGeneration) return; state.calendarEvents = data.events || []; state.calendarProjects = data.projects || state.projects; if (!state.calendarFilter.size) state.calendarProjects.forEach((project) => state.calendarFilter.add(project.id)); renderCalendar(); }
  catch (error) { elements.calendar_grid.textContent = error.message; }
}

function renderCalendar() {
  const year = state.calendarDate.getFullYear(), month = state.calendarDate.getMonth();
  elements.calendar_title.textContent = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(state.calendarDate);
  elements.calendar_filters.replaceChildren(...state.calendarProjects.map((project) => { const label = document.createElement("label"); const input = document.createElement("input"); input.type = "checkbox"; input.checked = state.calendarFilter.has(project.id); input.addEventListener("change", () => { input.checked ? state.calendarFilter.add(project.id) : state.calendarFilter.delete(project.id); renderCalendar(); }); label.append(input, document.createTextNode(project.name)); return label; }));
  const first = new Date(year, month, 1), start = new Date(year, month, 1 - ((first.getDay() + 6) % 7)); elements.calendar_grid.replaceChildren();
  for (const weekday of ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]) { const head = document.createElement("div"); head.className = "calendar-weekday"; head.textContent = weekday; elements.calendar_grid.append(head); }
  for (let dayIndex = 0; dayIndex < 42; dayIndex += 1) { const date = new Date(start); date.setDate(start.getDate() + dayIndex); const cell = document.createElement("section"); cell.className = `calendar-day${date.getMonth() === month ? "" : " muted"}`; const number = document.createElement("strong"); number.textContent = date.getDate(); cell.append(number); const events = state.calendarEvents.filter((event) => state.calendarFilter.has(event.projectId) && sameDay(new Date(event.at), date)); for (const event of events) cell.append(calendarEvent(event)); cell.addEventListener("dblclick", () => { if (date >= new Date()) { setMode("editor"); elements.schedule_at_input.value = toLocalInput(date); } }); elements.calendar_grid.append(cell); }
  const monthEvents = state.calendarEvents.filter((event) => { const at = new Date(event.at); return at.getFullYear() === year && at.getMonth() === month && state.calendarFilter.has(event.projectId); }).sort((a, b) => new Date(a.at) - new Date(b.at));
  elements.calendar_agenda.replaceChildren(...(monthEvents.length ? monthEvents.map(calendarEvent) : [Object.assign(document.createElement("div"), { className: "empty-list", textContent: "На этот месяц публикаций нет" })]));
}

function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function calendarEvent(event) { const item = document.createElement(event.url ? "a" : "button"); item.className = "calendar-event"; item.dataset.status = event.status; item.style.setProperty("--event-color", event.color || state.calendarProjects.find((project) => project.id === event.projectId)?.color || "#1e45fb"); if (event.url) { item.href = safeHttpUrl(event.url) || "#"; item.target = "_blank"; item.rel = "noopener noreferrer"; } else { item.type = "button"; item.addEventListener("click", async () => { if (event.projectId !== state.projectId && !(await switchProject(event.projectId))) return; state.archiveOrigin = false; setMode("editor"); await selectPost(event.id); }); } const time = document.createElement("time"); time.textContent = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(event.at)); const body = document.createElement("span"); const title = document.createElement("strong"); title.textContent = event.title; const meta = document.createElement("small"); meta.textContent = `${event.projectName || event.projectId} · ${STATUS_LABELS[event.status] || event.status}`; body.append(title, meta); item.append(time, body); return item; }

function renderArchive() {
  const search = elements.archive_search.value.trim().toLocaleLowerCase("ru");
  const posts = state.posts.filter(isPublished).filter((post) => !search || `${post.title} ${post.brief} ${post.text}`.toLocaleLowerCase("ru").includes(search));
  elements.archive_list.replaceChildren();
  if (!posts.length) elements.archive_list.append(Object.assign(document.createElement("div"), { className: "empty-list", textContent: "Опубликованных материалов пока нет" }));
  const topics = [...new Set([...state.topics.map(topic => topic.id), ...posts.map(post => post.topic)])];
  for (const topic of topics) {
    const group = posts.filter(post => post.topic === topic);
    if (!group.length) continue;
    const section = document.createElement("section"); section.className = "archive-topic";
    const heading = document.createElement("h2"); heading.textContent = `${topicName(topic)} · ${group.length}`; section.append(heading);
    for (const post of group) {
      const row = document.createElement("button"); row.type = "button"; row.className = "archive-row";
      const thumbnail = document.createElement(post.image?.url ? "img" : "span"); thumbnail.className = "archive-thumbnail";
      if (post.image?.url) { thumbnail.src = projectUrl(post.image.url); thumbnail.alt = ""; thumbnail.loading = "lazy"; }
      else { thumbnail.textContent = "Текст"; }
      const body = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = post.title || "Без названия";
      const meta = document.createElement("span"); meta.textContent = `Опубликовано ${formatPublicationDate(post.publication?.finishedAt || post.publication?.manuallyConfirmedAt)}`;
      const action = document.createElement("small"); action.textContent = "Открыть историю";
      body.append(title, meta, action); row.append(thumbnail, body);
      row.addEventListener("click", async () => { state.archiveOrigin = true; setMode("editor"); await selectPost(post.id); }); section.append(row);
    }
    elements.archive_list.append(section);
  }
}

async function openTeamLogin() {
  try { const response = await fetch("/api/team", { credentials: "same-origin" }); const status = await response.json(); state.teamEnabled = Boolean(status.enabled); state.user = status.enabled ? status.user || null : null; elements.team_dialog_title.textContent = state.user ? `${state.user.name} · ${state.user.role}` : status.enabled ? "Вход в редакцию" : "Создать владельца"; elements.team_submit.textContent = status.enabled ? "Войти" : "Создать и войти"; elements.team_submit.hidden = Boolean(state.user); $("team-login-fields").hidden = Boolean(state.user); elements.team_logout.hidden = !state.user; if (!elements.team_dialog.open && !state.user) elements.team_dialog.showModal(); } catch { /* state screen will show server error */ }
}

async function openTeamPanel() { if (!state.teamEnabled || !state.user) { await openTeamLogin(); if (!elements.team_dialog.open) elements.team_dialog.showModal(); return; } if (can("admin")) await openMembers(); else { await openTeamLogin(); if (!elements.team_dialog.open) elements.team_dialog.showModal(); } }
async function logoutTeam() {
  if (hasDirtyDrafts() && !window.confirm("Выйти? Несохранённые правки будут потеряны.")) return;
  try { await api("/team/logout", { method: "POST", headers: MUTATION_HEADERS, body: "{}" }); window.location.reload(); }
  catch (error) { showMessage(elements.team_error, error.message); }
}

async function submitTeam() {
  showMessage(elements.team_error, "");
  try { const route = state.teamEnabled ? "/team/login" : "/team/setup"; const data = await api(route, { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify({ name: elements.team_name.value.trim(), password: elements.team_password.value }) }); state.user = data.user; state.teamEnabled = true; elements.team_password.value = ""; elements.team_dialog.close(); const projectsData = await api("/projects"); state.projects = projectsData.projects || []; if (!state.projects.some((project) => project.id === state.projectId)) { rememberProjectDrafts(); state.projectId = state.projects[0]?.id || "default"; localStorage.setItem("editor-project", state.projectId); resetProjectWorkspace(); } await refreshState(); }
  catch (error) { showMessage(elements.team_error, error.message); }
}

async function openMembers() {
  try { const data = await api("/team/users"); state.users = data.users || data || []; elements.member_list.replaceChildren(...state.users.map((user) => { const row = document.createElement("div"); row.className = "dialog-row"; const text = document.createElement("span"); text.textContent = `${user.name} · ${user.role} · ${(user.projectIds || []).join(", ")}${user.disabled ? " · отключён" : ""}`; row.append(text); if (!user.disabled && user.id !== state.user?.id) { const disable = document.createElement("button"); disable.type = "button"; disable.className = "text-button"; disable.textContent = "Отключить"; disable.addEventListener("click", () => disableMember(user.id)); row.append(disable); } return row; })); elements.member_projects.replaceChildren(new Option("Все проекты", "*"), ...state.projects.map((project) => new Option(project.name, project.id))); showMessage(elements.member_error, ""); elements.members_dialog.showModal(); }
  catch (error) { showMessage(elements.member_error, error.message); }
}

async function disableMember(id) { if (!window.confirm("Отключить участника? Его активные сессии перестанут работать.")) return; try { await api(`/team/users/${encodeURIComponent(id)}`, { method: "PATCH", headers: MUTATION_HEADERS, body: JSON.stringify({ disabled: true }) }); await openMembers(); } catch (error) { showMessage(elements.member_error, error.message); } }

async function createMember() { try { const role = elements.member_role.value; await api("/team/users", { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify({ name: elements.member_name.value.trim(), password: elements.member_password.value, role, projectIds: role === "owner" ? ["*"] : [...elements.member_projects.selectedOptions].map((option) => option.value).filter((id) => id !== "*") }) }); elements.member_password.value = ""; await openMembers(); } catch (error) { showMessage(elements.member_error, error.message); } }

async function refreshState() {
  const generation = state.requestGeneration;
  try {
    const data = await api("/state");
    if (generation !== state.requestGeneration) return;
    const previousRouteVersion = state.settings?.routeVersion;
    state.posts = data.posts || []; state.trash = data.trash || []; state.ideaBatches = data.ideaBatches || []; state.projects = data.projects || state.projects; state.project = data.project || state.projects.find((project) => project.id === state.projectId) || null; state.user = data.user || state.user; state.members = data.members || []; state.teamEnabled = Boolean(data.teamEnabled); state.topics = data.topics?.length ? data.topics : state.project?.topics?.length ? state.project.topics : TOPIC_FALLBACK; state.settings = data.settings || state.settings;
    renderProjectChrome();
    const routeChanged = previousRouteVersion !== undefined && state.settings?.routeVersion !== previousRouteVersion;
    if (routeChanged) state.preview = null;
    if (!state.initialTopicChosen) {
      const firstTopicWithPosts = state.topics.find((topic) => state.posts.some((post) => post.topic === topic.id));
      if (firstTopicWithPosts && !state.posts.some((post) => post.topic === state.activeTopic)) state.activeTopic = firstTopicWithPosts.id;
      state.initialTopicChosen = true;
    }
    if (!state.topics.some((topic) => topic.id === state.activeTopic)) state.activeTopic = state.topics[0]?.id || "main";
    renderTopics(); renderQueue(); if (state.mode === "calendar") await loadCalendar(); if (state.mode === "archive") renderArchive(); if (elements.trash_dialog.open) renderTrash(); if (elements.ideas_dialog.open) renderIdeaBatches();
    if (!elements.settings_dialog.open) renderSettings();
    if (state.selectedId) {
      const fresh = state.posts.find((post) => post.id === state.selectedId);
      const draft = currentDraft();
      if (fresh && (!draft?.dirty || fresh.revision !== state.selectedPost?.revision)) {
        const full = await api(`/posts/${encodeURIComponent(state.selectedId)}`);
        if (generation !== state.requestGeneration || state.selectedId !== full.id) return;
        state.selectedPost = full;
        if (!draft?.dirty) state.drafts.set(full.id, makeDraft(full));
        renderEditor();
        if (!draft?.dirty) await loadPreview();
      }
      else if (routeChanged && !draft?.dirty) await loadPreview();
    }
  } catch (error) {
    if (state.selectedId) showMessage(elements.error_banner, `Не удалось обновить данные: ${error.message}`);
    else { elements.post_list.replaceChildren(); const item = document.createElement("div"); item.className = "empty-list"; item.textContent = `Редакция недоступна: ${error.message}`; elements.post_list.append(item); }
  }
}

async function bootstrap() {
  try {
    const { projects = [] } = await api("/projects"); state.projects = projects;
    if (!projects.some((project) => project.id === state.projectId)) state.projectId = projects[0]?.id || "default";
    localStorage.setItem("editor-project", state.projectId); setProjectLocation(state.projectId, false); await refreshState(); await loadCodex(); if (state.requestedPostId && state.posts.some((post) => post.id === state.requestedPostId)) { const postId = state.requestedPostId; state.requestedPostId = null; await selectPost(postId); }
  } catch (error) { if (!state.teamEnabled) await openTeamLogin(); }
}

function bindEvents() {
  elements.search_input.addEventListener("input", () => { state.queueRenderKey = ""; renderQueue(); }); elements.status_filter.addEventListener("change", () => { state.queueRenderKey = ""; renderQueue(); });
  elements.select_visible.addEventListener("change", () => { for (const post of visiblePosts().filter(canTrash)) elements.select_visible.checked ? state.selectedQueueIds.add(post.id) : state.selectedQueueIds.delete(post.id); state.queueRenderKey = ""; renderQueue(); });
  elements.bulk_delete_button.addEventListener("click", () => trashPosts(visiblePosts().filter((post) => state.selectedQueueIds.has(post.id) && canTrash(post))));
  elements.trash_button.addEventListener("click", () => { renderTrash(); elements.trash_dialog.showModal(); });
  elements.ideas_button.addEventListener("click", openIdeas); elements.ideas_create.addEventListener("click", createIdeaBatch);
  bindRichEditor(elements.text_input, markDirty);
  [elements.title_input, elements.brief_input, elements.text_input, elements.due_at_input].forEach((input) => input.addEventListener("input", markDirty));
  elements.save_button.addEventListener("click", () => savePost().catch(() => {}));
  elements.post_job_button.addEventListener("click", () => startJob("post")); elements.text_job_button.addEventListener("click", () => startJob("text")); elements.image_job_button.addEventListener("click", () => startJob("image")); elements.cancel_job_button.addEventListener("click", cancelJob);
  elements.archive_back_button.addEventListener("click", () => { state.archiveOrigin = false; setMode("archive"); });
  elements.refresh_preview_button.addEventListener("click", loadPreview); elements.publish_button.addEventListener("click", publishPost); elements.reconcile_button.addEventListener("click", reconcilePost);
  elements.image_input.addEventListener("change", () => uploadImage(elements.image_input.files[0])); elements.remove_image_button.addEventListener("click", removeImage);
  elements.settings_button.addEventListener("click", openSettings); elements.save_settings_button.addEventListener("click", saveSettings); elements.verify_settings_button.addEventListener("click", verifySettings);
  elements.backup_button.addEventListener("click", downloadBackup);
  elements.destination_type_input.addEventListener("change", () => { elements.topic_settings.closest("fieldset").hidden = elements.destination_type_input.value === "channel"; });
  elements.new_post_button.addEventListener("click", openNewPost); elements.create_post_button.addEventListener("click", createPost);
  elements.project_select.addEventListener("change", () => switchProject(elements.project_select.value)); elements.project_button.addEventListener("click", () => openProjectDialog(false)); elements.new_project_button.addEventListener("click", () => openProjectDialog(true)); elements.save_project_button.addEventListener("click", saveProject); elements.add_project_topic.addEventListener("click", () => elements.project_topics.append(projectTopicRow()));
  document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  elements.approve_button.addEventListener("click", approvePost); elements.schedule_button.addEventListener("click", schedulePost); elements.unschedule_button.addEventListener("click", unschedulePost); elements.schedule_at_input.addEventListener("input", () => { const post = state.selectedPost; if (post) { state.scheduleDrafts.set(scheduleDraftKey(post), elements.schedule_at_input.value); elements.schedule_button.disabled = !can("publish") || currentDraft()?.dirty || post.approval?.revision !== post.revision || !elements.schedule_at_input.value; } });
  elements.calendar_prev.addEventListener("click", () => { state.calendarDate.setDate(1); state.calendarDate.setMonth(state.calendarDate.getMonth() - 1); renderCalendar(); }); elements.calendar_next.addEventListener("click", () => { state.calendarDate.setDate(1); state.calendarDate.setMonth(state.calendarDate.getMonth() + 1); renderCalendar(); }); elements.calendar_today.addEventListener("click", () => { state.calendarDate = new Date(); renderCalendar(); }); elements.archive_search.addEventListener("input", renderArchive);
  elements.team_submit.addEventListener("click", submitTeam); elements.members_button.addEventListener("click", openTeamPanel); elements.member_create.addEventListener("click", createMember); elements.team_logout.addEventListener("click", logoutTeam); elements.members_logout.addEventListener("click", logoutTeam);
  document.querySelectorAll(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  window.addEventListener("beforeunload", (event) => { if (hasDirtyDrafts()) { event.preventDefault(); event.returnValue = ""; } });
}

bindEvents();
renderTopics();
renderQueue();
renderSettings();
bootstrap();
setInterval(refreshState, 3000);
