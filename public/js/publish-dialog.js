// One dialog for "now" and "on schedule": shows exactly what goes where before anything is sent.
import { plural, projectUrl } from "./api.js";

export function composition(parts = []) {
  const photo = parts.find((part) => part.type === "photo"), texts = parts.filter((part) => part.type === "text").length;
  const messages = `${texts} ${plural(texts, "сообщение", "сообщения", "сообщений")}`;
  if (photo && photo.caption) return "Фото с подписью";
  if (photo && texts) return `Фото и ${messages}`;
  if (photo) return "Фото без подписи";
  return messages.replace(/^./, (letter) => letter.toUpperCase());
}

const toLocalInput = (date) => new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
function nextHour() { const date = new Date(Date.now() + 60 * 60 * 1000); date.setMinutes(0, 0, 0); return date; }

export class PublishDialog {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.e = { dialog: $("publish-dialog"), title: $("publish-title"), thumb: $("publish-thumb"), destination: $("publish-destination"), composition: $("publish-composition"), excerpt: $("publish-excerpt"), issues: $("publish-issues"), at: $("publish-at"), timezone: $("publish-timezone"), error: $("publish-error"), confirm: $("publish-confirm") };
    this.handler = null; this.pending = false;
    for (const radio of this.e.dialog.querySelectorAll('input[name="publish-when"]')) radio.addEventListener("change", () => this.sync());
    this.e.at.addEventListener("input", () => this.sync());
    this.e.confirm.addEventListener("click", () => this.confirm());
    this.e.dialog.addEventListener("close", () => { if (!this.pending) this.handler = null; });
  }

  get when() { return this.e.dialog.querySelector('input[name="publish-when"]:checked')?.value || "now"; }

  open({ post, preview, mode = "now", at = null, onConfirm }) {
    this.handler = onConfirm; this.post = post;
    this.e.dialog.querySelector(`input[name="publish-when"][value="${mode === "at" ? "at" : "now"}"]`).checked = true;
    this.e.at.value = toLocalInput(at && at > new Date() ? at : nextHour());
    this.e.timezone.textContent = `Время по вашему компьютеру: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
    this.e.error.hidden = true;
    this.render(preview);
    if (!this.e.dialog.open) this.e.dialog.showModal();
  }

  render(preview) {
    this.preview = preview;
    const { e } = this, post = this.post;
    e.destination.textContent = preview?.destination || "Адресат не настроен";
    e.composition.textContent = composition(preview?.parts || []);
    e.thumb.replaceChildren();
    const photo = preview?.parts?.find((part) => part.type === "photo");
    if (photo?.url) { const image = document.createElement("img"); image.src = projectUrl(photo.url); image.alt = ""; e.thumb.append(image); }
    else { const none = document.createElement("span"); none.textContent = "Без картинки"; e.thumb.append(none); }
    const text = String(post?.text || "").replace(/\s+/g, " ").trim();
    e.excerpt.textContent = text.length > 220 ? `${text.slice(0, 219)}…` : text;
    e.issues.replaceChildren(...(preview?.issues || []).map((issue) => Object.assign(document.createElement("li"), { textContent: issue })));
    this.sync();
  }

  sync() {
    const scheduled = this.when === "at", { e } = this;
    e.at.hidden = !scheduled; e.timezone.hidden = !scheduled;
    e.title.textContent = scheduled ? "Запланировать публикацию" : "Опубликовать сейчас";
    e.confirm.textContent = this.pending ? (scheduled ? "Планируем…" : "Публикуем…") : scheduled ? "Запланировать" : "Опубликовать";
    e.confirm.disabled = this.pending || Boolean(this.preview?.issues?.length) || !this.preview;
  }

  async confirm() {
    if (!this.handler || this.pending) return;
    let at = null;
    if (this.when === "at") {
      at = new Date(this.e.at.value);
      if (Number.isNaN(at.valueOf()) || at.valueOf() <= Date.now() + 60 * 1000) { this.fail("Выберите время хотя бы на минуту позже текущего."); return; }
    }
    this.pending = true; this.e.error.hidden = true; this.sync();
    try { await this.handler({ at }); this.pending = false; this.e.dialog.close(); }
    catch (error) { this.pending = false; this.fail(error.message); }
    finally { this.sync(); }
  }

  fail(message) { this.e.error.textContent = message; this.e.error.hidden = false; }
}
