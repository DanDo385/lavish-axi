import { parse } from "parse5";

// The editor's source model and its preview document builder.
//
// Two rules shape everything here. The served artifact must stay byte-identical to the file on
// disk, so an unsaved draft can never be previewed through `/artifact/*`; the preview is a
// separate document built from the draft and handed to a sandboxed frame that never receives the
// Lavish SDK. And the preview must show what the user wrote, so it is built by splicing the
// parser's own source offsets - the same technique `src/html-transform.js` uses for the SDK tag -
// rather than re-serializing a parsed tree, which would silently rewrite markup the user is
// still editing.

// Largest source file a pane will load and the largest body a write will accept. A file above it
// is reported rather than truncated: a pane that silently holds half a file would write that half
// back over the whole one.
export const MAX_EDITOR_FILE_BYTES = 2 * 1024 * 1024;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const CSS_EXTENSIONS = new Set([".css"]);
const JS_EXTENSIONS = new Set([".js", ".mjs"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

/**
 * A reference the preview may replace with draft text. Only a relative, in-tree URL qualifies:
 * an absolute URL, a protocol-relative one, a root-relative one, and anything that climbs out of
 * the artifact tree all name something this session does not own, so the preview leaves them
 * exactly as the artifact wrote them.
 * @param {string} value
 */
export function isLocalArtifactUrl(value) {
  const url = String(value ?? "").trim();
  if (!url) return false;
  if (url.startsWith("//") || url.startsWith("/") || url.startsWith("#")) return false;
  if (SCHEME_RE.test(url)) return false;
  return normalizeEditorRelPath(url) !== "";
}

/**
 * The artifact-tree-relative path a URL or pane id names, with the query and fragment dropped and
 * `.`/`..` segments resolved. Returns "" for anything that escapes the tree or is not a path, so
 * every caller can treat "" as "not an editable source in this session".
 * @param {string} value
 */
export function normalizeEditorRelPath(value) {
  const raw = String(value ?? "")
    .trim()
    .split("#")[0]
    .split("?")[0];
  if (!raw || raw.startsWith("/") || raw.startsWith("\\")) return "";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed escape is not a path we can confine; fall through with the raw text, which the
    // segment walk below rejects if it climbs out.
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return "";
  const segments = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return "";
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Which pane a source belongs in, derived from its extension alone. Returns "" for everything
 * else, which is what keeps the editor to HTML, CSS, and JS.
 * @param {string} rel
 */
export function editorSourceKind(rel) {
  const normalized = normalizeEditorRelPath(rel);
  if (!normalized) return "";
  const dot = normalized.lastIndexOf(".");
  if (dot === -1) return "";
  const extension = normalized.slice(dot).toLowerCase();
  if (HTML_EXTENSIONS.has(extension)) return "html";
  if (CSS_EXTENSIONS.has(extension)) return "css";
  if (JS_EXTENSIONS.has(extension)) return "js";
  return "";
}

/**
 * Every stylesheet and script the artifact loads from its own tree, with the source offsets of the
 * element that loads it. parse5 reports those offsets the way a browser reads the document, so a
 * `</script>` inside a string or a comment cannot be mistaken for the end of an element.
 * @param {string} html
 * @returns {{ kind: "css" | "js", rel: string, url: string, startOffset: number, endOffset: number }[]}
 */
export function editorAssetRefs(html) {
  const refs = [];
  walk(parse(String(html ?? ""), { sourceCodeLocationInfo: true }), (node) => {
    const location = node.sourceCodeLocation;
    if (!location || !Number.isInteger(location.startOffset) || !Number.isInteger(location.endOffset)) return;
    const kind = refKind(node);
    if (!kind) return;
    const url = attrValue(node, kind === "css" ? "href" : "src");
    if (!isLocalArtifactUrl(url)) return;
    const rel = normalizeEditorRelPath(url);
    if (editorSourceKind(rel) !== kind) return;
    refs.push({ kind, rel, url, startOffset: location.startOffset, endOffset: location.endOffset });
  });
  return refs.sort((a, b) => a.startOffset - b.startOffset);
}

/**
 * The document the preview frame renders.
 *
 * `<base>` points relative URLs at this session's artifact-asset route, so images, fonts, and any
 * sibling the panes do not own still resolve while the draft lives only in the browser. Each
 * override replaces the element that loaded that file with the draft text inlined, because a
 * `<link>` would otherwise fetch the saved bytes and show the user the file they are replacing.
 * Nothing else about the document changes, and the Lavish SDK is deliberately absent: the preview
 * is untrusted artifact content and gets no bridge to the agent.
 * @param {{ html?: string, baseHref?: string, overrides?: { rel: string, kind?: string, contents: string }[] }} [input]
 */
export function buildEditorPreviewDocument({ html, baseHref = "", overrides = [] } = {}) {
  const source = String(html ?? "");
  const byRel = new Map();
  for (const override of overrides || []) {
    const rel = normalizeEditorRelPath(override?.rel);
    if (!rel) continue;
    byRel.set(rel, String(override?.contents ?? ""));
  }

  const edits = [];
  const base = String(baseHref || "").trim();
  if (base) {
    const offset = baseInsertOffset(source);
    edits.push({ start: offset, end: offset, text: `<base href="${escapeAttribute(base)}">` });
  }
  for (const ref of editorAssetRefs(source)) {
    if (!byRel.has(ref.rel)) continue;
    const contents = byRel.get(ref.rel);
    const text =
      ref.kind === "css"
        ? `<style data-lavish-editor-draft="${escapeAttribute(ref.rel)}">${escapeRawText(contents, "style")}</style>`
        : `<script data-lavish-editor-draft="${escapeAttribute(ref.rel)}">${escapeRawText(contents, "script")}</script>`;
    edits.push({ start: ref.startOffset, end: ref.endOffset, text });
  }

  // Apply back to front so every offset the parser reported still addresses the same bytes.
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of edits) {
    out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
  }
  return out;
}

/**
 * What a pane can do with a file's bytes. A file is read once and classified once: the write route
 * re-reads and re-classifies rather than trusting a pane's claim about what it holds.
 * @param {Buffer | Uint8Array} bytes
 * @returns {{ state: "text" | "empty" | "binary" | "too-large", text: string, bytes: number }}
 */
export function classifyEditorSource(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  if (data.byteLength > MAX_EDITOR_FILE_BYTES) return { state: "too-large", text: "", bytes: data.byteLength };
  if (data.includes(0)) return { state: "binary", text: "", bytes: data.byteLength };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return { state: "binary", text: "", bytes: data.byteLength };
  }
  if (text.trim() === "") return { state: "empty", text, bytes: data.byteLength };
  return { state: "text", text, bytes: data.byteLength };
}

/** A pane whose state allows editing and saving. */
export function isEditableEditorState(state) {
  return state === "text" || state === "empty";
}

function refKind(node) {
  if (node.tagName === "link") {
    const rel = attrValue(node, "rel").toLowerCase().split(/\s+/);
    return rel.includes("stylesheet") ? "css" : "";
  }
  if (node.tagName === "script") {
    const type = attrValue(node, "type").trim().toLowerCase();
    // A module script is still a script; a JSON or template `type` is data the preview must not
    // turn into executable inline source.
    if (type && type !== "module" && type !== "text/javascript" && type !== "application/javascript") return "";
    return "js";
  }
  return "";
}

function attrValue(node, name) {
  const attr = (node.attrs || []).find((candidate) => candidate.name === name);
  return attr ? String(attr.value ?? "") : "";
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
  // `<template>` content is inert markup the browser never loads assets from, so it is skipped.
}

/**
 * Where `<base>` may be inserted so it precedes every relative URL in the document. The head's
 * start tag is the right place when the artifact wrote one; otherwise the document element's, and
 * failing that after a doctype, because inserting before a doctype would drop the page into quirks
 * mode and change the layout the user is trying to review.
 */
function baseInsertOffset(html) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  let headStart;
  let htmlStart;
  let doctypeEnd = 0;
  walk(document, (node) => {
    const startTagEnd = node.sourceCodeLocation?.startTag?.endOffset;
    if (node.tagName === "head" && headStart === undefined) headStart = startTagEnd;
    if (node.tagName === "html" && htmlStart === undefined) htmlStart = startTagEnd;
    if (node.nodeName === "#documentType" && node.sourceCodeLocation) {
      doctypeEnd = Math.max(doctypeEnd, node.sourceCodeLocation.endOffset || 0);
    }
  });
  if (Number.isInteger(headStart)) return headStart;
  if (Number.isInteger(htmlStart)) return htmlStart;
  return doctypeEnd;
}

// Break the closing tag of raw-text content so inlined CSS or JS containing `</style>` or
// `</script>` cannot end the element early. The escape is valid inside the string where such a
// token can legitimately appear.
function escapeRawText(text, tag) {
  return String(text).replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
