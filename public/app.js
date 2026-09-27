import { configureApi, api, fetchState, projectUrl, safeHttpUrl, plural } from "./js/api.js";
import { CardView } from "./js/card.js";
"use strict";

const TOPIC_FALLBACK = [{ id: "main", name: "Главная" }];
const STATUS_LABELS = { idea: "Идея", working: "В работе", review: "На проверке", approved: "Согласовано", scheduled: "Запланировано", publishing: "Публикуется", published: "Опубликовано", missed: "Пропущено", failed: "Ошибка", uncertain: "Нужна сверка" };
const MUTATION_HEADERS = { "Content-Type": "application/json", "X-Editor-Request": "editor" };

const state = {
  posts: [], topics: TOPIC_FALLBACK, settings: null, codex: null,
  activeTopic: "main", selectedId: null,
  topicRenderKey: "", queueRenderKey: "", initialTopicChosen: false,
  mutationInFlight: false, stateEtag: null,
  trash: [], ideaBatches: [], selectedQueueIds: new Set(), selectedIdeaIds: new Set(),
  projects: [], project: null, projectId: new URLSearchParams(location.search).get("project") || localStorage.getItem("editor-project") || "default", requestedPostId: new URLSearchParams(location.search).get("post"), user: null, teamEnabled: false,
  mode: "editor", calendarDate: new Date(), calendarEvents: [], calendarProjects: [], calendarFilter: new Set(), users: [], requestGeneration: 0,
  archiveOrigin: false,
};

const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "topic-nav","settings-state","codex-state","settings-button","members-button","brand-project","project-select","project-button","new-post-button","ideas-button","search-input","status-filter","queue-count","post-list","select-visible","bulk-delete-button","selected-count","trash-button","editor-mode","queue-toggle","queue-close","calendar-title","calendar-prev","calendar-next","calendar-today","calendar-filters","calendar-grid","calendar-agenda","archive-search","archive-list","settings-dialog","settings-form","settings-error","codex-detail","telegram-detail","token-input","destination-type-input","chat-id-input","topic-settings","verify-settings-button","save-settings-button","project-dialog","project-dialog-title","project-name","project-color","project-audience","project-language","project-voice","project-visual-style","project-examples","project-instructions","project-timezone","project-topics","add-project-topic","project-error","new-project-button","save-project-button","team-dialog","team-dialog-title","team-name","team-password","team-error","team-submit","members-dialog","member-list","member-name","member-password","member-role","member-projects","member-create","member-error","new-post-dialog","new-topic","new-title","new-brief","new-post-error","create-post-button","trash-dialog","trash-error","trash-list","ideas-dialog","ideas-topic","ideas-count","ideas-feedback","ideas-error","ideas-create","ideas-batches"
].map((id) => [id.replaceAll("-", "_"), $(id)]));
elements.backup_button = $("backup-button");
elements.team_logout = $("team-logout"); elements.members_logout = $("members-logout");

configureApi({ projectId: () => state.projectId, onUnauthorized: () => openTeamLogin() });
const card = new CardView({
  context: () => ({ projectId: state.projectId, settings: state.settings, codex: state.codex, user: state.user, can, archiveOrigin: state.archiveOrigin, agentBusyElsewhere: state.posts.some((post) => post.id !== state.selectedId && isBusy(post)) || state.ideaBatches.some((batch) => batch.status === "running") }),
  onPostChanged: (post) => updateSummary(post),
  onArchiveBack: () => { state.archiveOrigin = false; setMode("archive"); },
});

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

function isBusy(post) {
  return ["running", "working"].includes(post?.job?.status);
}

function isPublished(post) {
  return post?.status === "published" && post?.publication?.status === "published";
}

function displayStatus(post) {
  return post?.status === "published" && post?.publication?.status && post.publication.status !== "published" ? post.publication.status : post?.status;
}

function canTrash(post) {
  return can("edit") && ["idea", "review"].includes(post?.status) && !isBusy(post) && !state.mutationInFlight;
}

function renderMutationLock() {
  state.queueRenderKey = "";
  renderQueue();
  if (card.post) card.render();
  if (elements.trash_dialog.open) renderTrash();
  if (elements.ideas_dialog.open) renderIdeaBatches();
}

// The polling state carries summaries; a card's own view keeps the full record.
function updateSummary(post) {
  const summary = { ...post, logCount: post.agentLog?.length || 0, variantCount: post.imageVariants?.length || 0 };
  for (const key of ["history", "agentLog", "sources", "comments", "duplicateCheck", "imageVariants"]) delete summary[key];
  state.posts = state.posts.map((item) => item.id === post.id ? summary : item);
  renderQueue();
}

function setQueueOpen(open) {
  elements.editor_mode.classList.toggle("queue-open", open);
  elements.queue_toggle.setAttribute("aria-expanded", String(open));
}

function setPostLocation(id) {
  const url = new URL(window.location.href);
  url.searchParams.set("project", state.projectId);
  if (id) url.searchParams.set("post", id); else url.searchParams.delete("post");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

// Opening a card also switches the queue to its topic, so a direct link or a calendar click shows where the card lives.
async function selectPost(id) {
  if (state.selectedId === id && card.post?.id === id) { setQueueOpen(false); return; }
  if (!(await card.leave())) return;
  state.selectedId = id;
  const summary = state.posts.find((post) => post.id === id);
  if (summary && !isPublished(summary) && summary.topic !== state.activeTopic && state.topics.some((topic) => topic.id === summary.topic)) { state.activeTopic = summary.topic; renderTopics(); }
  setPostLocation(id);
  elements.editor_mode.classList.add("has-card"); setQueueOpen(false);
  state.queueRenderKey = ""; renderQueue();
  await card.open(id);
}

function closeCard() {
  card.close(); state.selectedId = null; setPostLocation(null);
  elements.editor_mode.classList.remove("has-card", "queue-open");
  state.queueRenderKey = ""; renderQueue();
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
  renderCodex();
}

function renderCodex() {
  const codex = state.codex;
  const text = !codex ? "Проверяем…" : codex.available && codex.authenticated ? `Готов${codex.version ? ` · ${codex.version}` : ""}` : codex.message || "Недоступен";
  elements.codex_state.textContent = text; elements.codex_detail.textContent = text;
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
  if (card.post) card.render();
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
  if (!window.confirm(`Переместить ${posts.length} ${plural(posts.length, "материал", "материала", "материалов")} в корзину? Их можно будет восстановить.`)) return;
  // An open card saves its pending edits first, so its latest revision goes to the trash.
  if (posts.some((post) => post.id === card.post?.id)) { try { await card.ensureSaved(); } catch (error) { card.error(error.message); return; } }
  state.mutationInFlight = true;
  renderMutationLock();
  try {
    const items = posts.map(({ id, revision }) => ({ id, revision: id === card.post?.id ? card.post.revision : revision }));
    const result = await api("/posts/trash", { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify({ items }) });
    const removed = new Set((result.posts || []).map((post) => post.id));
    state.posts = state.posts.filter((post) => !removed.has(post.id)); state.trash = [...(result.posts || []), ...state.trash.filter((post) => !removed.has(post.id))];
    for (const id of removed) state.selectedQueueIds.delete(id);
    if (removed.has(state.selectedId)) closeCard();
    state.queueRenderKey = ""; renderQueue(); renderTrash();
  } catch (error) { if (card.post) card.error(error.message); else window.alert(error.message); }
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

function resetProjectWorkspace() {
  state.requestGeneration += 1; state.posts = []; state.trash = []; state.ideaBatches = []; state.archiveOrigin = false; state.stateEtag = null; state.selectedQueueIds.clear(); state.queueRenderKey = ""; state.topicRenderKey = ""; state.initialTopicChosen = false;
  closeCard();
}

async function switchProject(projectId) {
  if (!projectId || projectId === state.projectId) return true;
  if (!(await card.leave())) { elements.project_select.value = state.projectId; return false; }
  state.projectId = projectId; localStorage.setItem("editor-project", projectId); setProjectLocation(projectId); resetProjectWorkspace(); await refreshState(); await loadCodex();
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
    if (creating && !(await card.leave())) return;
    const project = await api(creating ? "/projects" : `/projects/${encodeURIComponent(state.projectId)}`, { method: creating ? "POST" : "PATCH", headers: MUTATION_HEADERS, body: JSON.stringify(projectPayload()) });
    elements.project_dialog.close(); if (creating) { state.projectId = project.id; localStorage.setItem("editor-project", project.id); setProjectLocation(project.id); resetProjectWorkspace(); } await refreshState();
  } catch (error) { showMessage(elements.project_error, error.message); }
}

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
  for (let dayIndex = 0; dayIndex < 42; dayIndex += 1) { const date = new Date(start); date.setDate(start.getDate() + dayIndex); const cell = document.createElement("section"); cell.className = `calendar-day${date.getMonth() === month ? "" : " muted"}`; const number = document.createElement("strong"); number.textContent = date.getDate(); cell.append(number); const events = state.calendarEvents.filter((event) => state.calendarFilter.has(event.projectId) && sameDay(new Date(event.at), date)); for (const event of events) cell.append(calendarEvent(event)); cell.addEventListener("dblclick", () => { const at = new Date(date); at.setHours(10, 0, 0, 0); if (at > new Date()) { setMode("editor"); if (card.post) card.openPublish("at", at); } }); elements.calendar_grid.append(cell); }
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
  if (card.hasUnsaved() && !window.confirm("Выйти? Несохранённые правки будут потеряны.")) return;
  try { await api("/team/logout", { method: "POST", headers: MUTATION_HEADERS, body: "{}" }); window.location.reload(); }
  catch (error) { showMessage(elements.team_error, error.message); }
}

async function submitTeam() {
  showMessage(elements.team_error, "");
  try { const route = state.teamEnabled ? "/team/login" : "/team/setup"; const data = await api(route, { method: "POST", headers: MUTATION_HEADERS, body: JSON.stringify({ name: elements.team_name.value.trim(), password: elements.team_password.value }) }); state.user = data.user; state.teamEnabled = true; elements.team_password.value = ""; elements.team_dialog.close(); const projectsData = await api("/projects"); state.projects = projectsData.projects || []; if (!state.projects.some((project) => project.id === state.projectId)) { await card.leave(); state.projectId = state.projects[0]?.id || "default"; localStorage.setItem("editor-project", state.projectId); resetProjectWorkspace(); } await refreshState(); }
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
    const result = await fetchState(state.stateEtag);
    if (generation !== state.requestGeneration || result.notModified) return;
    state.stateEtag = result.etag;
    const data = result.data, previousSettings = state.settings;
    state.posts = data.posts || []; state.trash = data.trash || []; state.ideaBatches = data.ideaBatches || []; state.projects = data.projects || state.projects; state.project = data.project || state.projects.find((project) => project.id === state.projectId) || null; state.user = data.user || state.user; state.members = data.members || []; state.teamEnabled = Boolean(data.teamEnabled); state.topics = data.topics?.length ? data.topics : state.project?.topics?.length ? state.project.topics : TOPIC_FALLBACK; state.settings = data.settings || state.settings;
    renderProjectChrome();
    // The queue starts on the first topic that still has unpublished cards.
    if (!state.initialTopicChosen) {
      const open = (topicId) => state.posts.some((post) => post.topic === topicId && !isPublished(post));
      const first = state.topics.find((topic) => open(topic.id));
      if (first && !open(state.activeTopic)) state.activeTopic = first.id;
      state.initialTopicChosen = true;
    }
    if (!state.topics.some((topic) => topic.id === state.activeTopic)) state.activeTopic = state.topics[0]?.id || "main";
    renderTopics(); renderQueue(); if (state.mode === "calendar") await loadCalendar(); if (state.mode === "archive") renderArchive(); if (elements.trash_dialog.open) renderTrash(); if (elements.ideas_dialog.open) renderIdeaBatches();
    if (!elements.settings_dialog.open) renderSettings();
    if (previousSettings && (previousSettings.routeVersion !== state.settings?.routeVersion || previousSettings.verified !== state.settings?.verified)) card.settingsChanged();
    if (state.selectedId) {
      const fresh = state.posts.find((post) => post.id === state.selectedId) || state.trash.find((post) => post.id === state.selectedId);
      if (fresh) card.syncSummary(fresh);
    }
  } catch (error) {
    if (card.post) { if (error.status !== 0) card.error(`Не удалось обновить данные: ${error.message}`); }
    else { elements.post_list.replaceChildren(); const item = document.createElement("div"); item.className = "empty-list"; item.textContent = `Редакция недоступна: ${error.message}`; elements.post_list.append(item); }
  }
}

async function bootstrap() {
  try {
    const { projects = [] } = await api("/projects"); state.projects = projects;
    if (!projects.some((project) => project.id === state.projectId)) state.projectId = projects[0]?.id || "default";
    localStorage.setItem("editor-project", state.projectId); setProjectLocation(state.projectId, false); await refreshState(); await loadCodex();
    const postId = state.requestedPostId; state.requestedPostId = null;
    if (postId && [...state.posts, ...state.trash].some((post) => post.id === postId)) { const post = state.posts.find((item) => item.id === postId); state.archiveOrigin = isPublished(post); await selectPost(postId); }
  } catch (error) { if (!state.teamEnabled) await openTeamLogin(); }
}

function bindEvents() {
  elements.search_input.addEventListener("input", () => { state.queueRenderKey = ""; renderQueue(); }); elements.status_filter.addEventListener("change", () => { state.queueRenderKey = ""; renderQueue(); });
  elements.select_visible.addEventListener("change", () => { for (const post of visiblePosts().filter(canTrash)) elements.select_visible.checked ? state.selectedQueueIds.add(post.id) : state.selectedQueueIds.delete(post.id); state.queueRenderKey = ""; renderQueue(); });
  elements.bulk_delete_button.addEventListener("click", () => trashPosts(visiblePosts().filter((post) => state.selectedQueueIds.has(post.id) && canTrash(post))));
  elements.trash_button.addEventListener("click", () => { renderTrash(); elements.trash_dialog.showModal(); });
  elements.ideas_button.addEventListener("click", openIdeas); elements.ideas_create.addEventListener("click", createIdeaBatch);
  elements.queue_toggle.addEventListener("click", () => setQueueOpen(!elements.editor_mode.classList.contains("queue-open")));
  elements.queue_close.addEventListener("click", () => setQueueOpen(false));
  elements.settings_button.addEventListener("click", openSettings); elements.save_settings_button.addEventListener("click", saveSettings); elements.verify_settings_button.addEventListener("click", verifySettings);
  elements.backup_button.addEventListener("click", downloadBackup);
  elements.destination_type_input.addEventListener("change", () => { elements.topic_settings.closest("fieldset").hidden = elements.destination_type_input.value === "channel"; });
  elements.new_post_button.addEventListener("click", openNewPost); elements.create_post_button.addEventListener("click", createPost);
  elements.project_select.addEventListener("change", () => switchProject(elements.project_select.value)); elements.project_button.addEventListener("click", () => openProjectDialog(false)); elements.new_project_button.addEventListener("click", () => openProjectDialog(true)); elements.save_project_button.addEventListener("click", saveProject); elements.add_project_topic.addEventListener("click", () => elements.project_topics.append(projectTopicRow()));
  document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  elements.calendar_prev.addEventListener("click", () => { state.calendarDate.setDate(1); state.calendarDate.setMonth(state.calendarDate.getMonth() - 1); renderCalendar(); }); elements.calendar_next.addEventListener("click", () => { state.calendarDate.setDate(1); state.calendarDate.setMonth(state.calendarDate.getMonth() + 1); renderCalendar(); }); elements.calendar_today.addEventListener("click", () => { state.calendarDate = new Date(); renderCalendar(); }); elements.archive_search.addEventListener("input", renderArchive);
  elements.team_submit.addEventListener("click", submitTeam); elements.members_button.addEventListener("click", openTeamPanel); elements.member_create.addEventListener("click", createMember); elements.team_logout.addEventListener("click", logoutTeam); elements.members_logout.addEventListener("click", logoutTeam);
  document.querySelectorAll(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  // ⌘S / Ctrl+S saves the open card at once; everything else is saved automatically.
  document.addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && !event.altKey && event.code === "KeyS") { event.preventDefault(); card.saveNow(); } if (event.key === "Escape" && elements.editor_mode.classList.contains("queue-open")) setQueueOpen(false); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshState(); });
  window.addEventListener("beforeunload", (event) => { if (card.hasUnsaved()) { card.saveNow(); event.preventDefault(); event.returnValue = ""; } });
}

bindEvents();
renderTopics();
renderQueue();
renderSettings();
bootstrap();
setInterval(() => { if (!document.hidden) refreshState(); }, 3000);
