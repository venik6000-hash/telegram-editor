// The strip of picture variants under the post image, with an upload tile at the end.
import { IMAGE_TYPES } from "./api.js";

const ORIGINS = { agent: "Агент", upload: "Загрузка", legacy: "Ранее" };
const time = (value) => { const date = new Date(value || ""); return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(date); };

export function variantTitle(variant, current) {
  return [ORIGINS[variant.origin], time(variant.createdAt), variant.instruction && `«${variant.instruction}»`, current && "сейчас на посте"].filter(Boolean).join(" · ");
}

export function renderVariants(container, post, { busy = false, readOnly = false, onSelect, onUpload, projectUrl = (url) => url }) {
  container.replaceChildren();
  const variants = [...(post.imageVariants || [])].reverse();
  for (const variant of variants) {
    const current = post.image?.name === variant.name;
    const button = document.createElement("button");
    button.type = "button"; button.className = `variant${current ? " current" : ""}`; button.dataset.origin = variant.origin || "legacy";
    button.setAttribute("aria-pressed", String(current));
    button.title = variantTitle(variant, current);
    button.setAttribute("aria-label", `Вариант картинки: ${button.title}`);
    button.disabled = busy || readOnly;
    const image = document.createElement("img"); image.src = projectUrl(variant.url); image.alt = ""; image.loading = "lazy";
    const badge = document.createElement("span"); badge.className = "variant-badge"; badge.textContent = ORIGINS[variant.origin] || "";
    button.append(image, badge);
    button.addEventListener("click", () => { if (!current) onSelect(variant); });
    container.append(button);
  }
  const upload = document.createElement("label");
  upload.className = `variant variant-upload${busy || readOnly ? " disabled" : ""}`;
  upload.title = "Загрузить свою картинку (PNG, JPEG или WebP до 8 МБ)";
  const input = document.createElement("input"); input.type = "file"; input.accept = IMAGE_TYPES.join(","); input.disabled = busy || readOnly;
  input.addEventListener("change", () => { const file = input.files[0]; input.value = ""; if (file) onUpload(file); });
  const plus = document.createElement("span"); plus.textContent = "+";
  const text = document.createElement("small"); text.textContent = "Загрузить";
  upload.append(input, plus, text);
  container.append(upload);
}
