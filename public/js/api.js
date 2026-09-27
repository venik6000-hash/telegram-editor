// Requests to the editor server. Every request carries the current project.
let currentProject = () => "default";
let unauthorized = () => {};

export class ApiError extends Error {
  constructor(message, status, payload = null) { super(message); this.status = status; this.payload = payload; }
}

export function configureApi({ projectId, onUnauthorized } = {}) {
  if (projectId) currentProject = projectId;
  if (onUnauthorized) unauthorized = onUnauthorized;
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Editor-Project", currentProject());
  const method = options.method || "GET";
  if (!["GET", "HEAD"].includes(method)) { headers.set("X-Editor-Request", "editor"); if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json"); }
  let response;
  try { response = await fetch(`/api${path}`, { ...options, method, headers, credentials: "same-origin" }); }
  catch { throw new ApiError("Нет связи с редакцией.", 0); }
  if (response.status === 304) return { response, payload: null };
  let payload = null;
  try { payload = await response.json(); } catch { /* not JSON */ }
  if (response.status === 401) { unauthorized(); throw new ApiError(payload?.error || "Нужно войти в редакцию", 401, payload); }
  if (!response.ok) throw new ApiError(payload?.error || `Ошибка сервера (${response.status})`, response.status, payload);
  return { response, payload };
}

export async function api(path, options = {}) { return (await request(path, options)).payload; }
export function send(path, method, body = {}) { return api(path, { method, body: JSON.stringify(body) }); }
export const postPath = (id, action = "") => `/posts/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

// The polling request: 304 means nothing changed since the given ETag.
export async function fetchState(etag) {
  const { response, payload } = await request("/state", { headers: etag ? { "If-None-Match": etag } : {} });
  if (response.status === 304) return { notModified: true };
  return { data: payload, etag: response.headers.get("ETag") };
}

export function readAsDataUrl(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("Не удалось прочитать файл")); reader.readAsDataURL(file); });
}

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export function checkImageFile(file) {
  if (!IMAGE_TYPES.includes(file?.type) || file.size > 8 * 1024 * 1024) throw new Error("Подойдёт PNG, JPEG или WebP размером до 8 МБ.");
}

// Same-origin media and attachment links carry the project, because <img> requests cannot send the project header.
export function projectUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, window.location.origin);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.origin === window.location.origin) url.searchParams.set("project", currentProject());
    return url.href;
  } catch { return ""; }
}

export function safeHttpUrl(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}

export function plural(number, one, few, many) {
  const mod10 = number % 10, mod100 = number % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
