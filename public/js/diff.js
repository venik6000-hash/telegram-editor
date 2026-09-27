// Word-level difference between two texts, used by the version dialog.
const TOKENS = /\s+|[^\s]+/g;
const LIMIT = 2_000_000;

export function diffWords(before = "", after = "") {
  const a = String(before).match(TOKENS) || [], b = String(after).match(TOKENS) || [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const parts = [
    ...a.slice(0, start).map((text) => ({ type: "same", text })),
    ...middle(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map((text) => ({ type: "same", text })),
  ];
  return merge(parts);
}

function middle(a, b) {
  if (!a.length) return b.map((text) => ({ type: "added", text }));
  if (!b.length) return a.map((text) => ({ type: "removed", text }));
  // Very long rewrites are shown as one replacement instead of an expensive table.
  if (a.length * b.length > LIMIT) return [{ type: "removed", text: a.join("") }, { type: "added", text: b.join("") }];
  const width = b.length + 1, table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1)
    table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const parts = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { parts.push({ type: "same", text: a[i] }); i += 1; j += 1; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { parts.push({ type: "removed", text: a[i] }); i += 1; }
    else { parts.push({ type: "added", text: b[j] }); j += 1; }
  }
  while (i < a.length) parts.push({ type: "removed", text: a[i++] });
  while (j < b.length) parts.push({ type: "added", text: b[j++] });
  return parts;
}

// Whitespace between two changed words joins the change, so the highlight reads as one phrase.
function merge(parts) {
  const result = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const last = result.at(-1);
    if (last && last.type === part.type) { last.text += part.text; continue; }
    result.push({ ...part });
  }
  return result;
}

export function diffStats(parts) {
  let added = 0, removed = 0;
  for (const part of parts) {
    const words = (part.text.match(/[^\s]+/g) || []).length;
    if (part.type === "added") added += words;
    if (part.type === "removed") removed += words;
  }
  return { added, removed };
}
