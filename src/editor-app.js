// The editor mode's two server-rendered pages.
//
// `/editor/:key` is an authority surface: it is the only page that may write an artifact's source
// files, so it is refused a frame (like the review chrome) and it holds no third-party code.
// `/editor-diff-frame` is the opposite: it renders the diff with `@pierre/diffs`, which is loaded
// at runtime from esm.sh exactly as the `code` playbook documents for artifacts, so it runs in an
// opaque-origin sandbox where that code cannot write a file, read the editor page, or pass the
// same-origin guard on `/api/:key/prompts`. It receives nothing but the text the user is already
// looking at, over postMessage.

// Pinned exactly, like every other runtime surface Lavish names: the playbook's verified no-build
// form is this specifier, and a floating range would change the diff renderer under the user.
export const EDITOR_DIFF_MODULE_URL = "https://esm.sh/@pierre/diffs@1.2.10?bundle";
export const EDITOR_DIFF_MODULE_ORIGIN = "https://esm.sh";

/**
 * The diff frame runs third-party code over the user's own source text. The sandbox already denies
 * it this origin's authority; this policy bounds where it may talk at all, so the one network
 * dependency the editor has cannot become an exfiltration path. `wasm-unsafe-eval` is what lets
 * Shiki's grammar engine start.
 *
 * The frame's own origin is opaque (sandboxed without `allow-same-origin`), so `'self'` names
 * nothing a source list can match: the Lavish origin this frame loads its client script from has
 * to be written out, and only the request knows it.
 * @param {string} selfOrigin
 */
export function editorDiffFrameCsp(selfOrigin) {
  const origin = String(selfOrigin || "").trim();
  const scriptSources = ["'unsafe-inline'", "'wasm-unsafe-eval'", EDITOR_DIFF_MODULE_ORIGIN];
  if (origin) scriptSources.push(origin);
  return [
    "default-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'unsafe-inline'",
    `connect-src ${EDITOR_DIFF_MODULE_ORIGIN}`,
    `font-src ${EDITOR_DIFF_MODULE_ORIGIN} data:`,
    "img-src data:",
  ].join("; ");
}

/**
 * @param {{ key: string, file: string }} session
 * @param {{ faviconTag?: string, title?: string, maxFileBytes?: number }} [options]
 */
export function createEditorHtml(session, { faviconTag = "", title = "Lavish Editor", maxFileBytes = 0 } = {}) {
  // Deliberately no module URL: the editor page is the surface that can write files, so the only
  // place the third-party renderer is named is the sandboxed frame that runs it.
  const bootJson = jsonScript({ key: session.key, file: session.file, maxFileBytes });
  const { head: pathHead, tail: pathTail } = displayPathParts(session.file);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
${faviconTag}
<link rel="stylesheet" href="/chrome.css">
<link rel="stylesheet" href="/editor.css">
</head>
<body class="lavish editor">
<div class="bar">
<div class="brand"><span class="brand-mark">Lavish</span><span class="brand-support">Source</span></div>
<span class="editor-file" title="${escapeHtml(session.file)}"><span class="path-head">${escapeHtml(pathHead)}</span><span class="path-tail">${escapeHtml(pathTail)}</span></span>
<div class="spacer" aria-hidden="true"></div>
<span class="editor-status" id="editorStatus" role="status" aria-live="polite"></span>
<button class="editor-ghost" id="previewToggle" type="button" aria-controls="editorPreview" aria-expanded="true">Hide preview</button>
<a class="editor-review-link" href="/session/${encodeURIComponent(session.key)}">Open review</a>
<button class="button" id="editorSave" type="button" disabled>Save to disk</button>
</div>
<div class="editor-layout" id="editorLayout">
<section class="editor-sources" aria-label="Sources">
<div class="editor-tabs" id="editorTabs" role="tablist" aria-label="Source files"></div>
<div class="editor-panes" id="editorPanes"></div>
<form class="editor-note" id="editorNoteForm">
<label class="editor-note-label" for="editorNote">Message the agent</label>
<textarea id="editorNote" rows="2" placeholder="Describe what you changed, or ask for a follow-up..."></textarea>
<div class="editor-note-actions"><span class="editor-note-hint">Nothing reaches the agent until you press Send. Saving a file never sends a message.</span><button class="button" id="editorNoteSend" type="submit" disabled>Send to agent</button></div>
</form>
</section>
<section class="editor-preview" id="editorPreview" aria-label="Preview">
<div class="editor-preview-head">
<h2>Preview</h2>
<span class="editor-preview-note">Sandboxed draft render. No Lavish SDK, no agent bridge, no access to this page.</span>
<button class="editor-ghost" id="previewRefresh" type="button">Refresh</button>
</div>
<div class="editor-preview-frame">
<iframe id="previewFrame" title="Draft preview" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"></iframe>
</div>
</section>
</div>
<script id="lavish-editor" type="application/json">${bootJson}</script>
<script src="/editor-client.js"></script>
</body>
</html>`;
}

export function createEditorDiffFrameHtml(moduleUrl = EDITOR_DIFF_MODULE_URL) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lavish diff</title>
<style>
/* The frame paints its own background rather than inheriting one: an opaque-origin frame with a
   transparent body shows white wherever the rendered diff does not reach. */
html{background:#0f1115;color-scheme:dark}
html.light{background:#f7f3ea;color-scheme:light}
body{margin:0;background:inherit;color:#f7f3ea;font:13px/1.5 Geist,ui-sans-serif,system-ui,sans-serif}
html.light body{color:#1b1f27}
#status{padding:14px 16px;color:#aeb6c6}
html.light #status{color:#4a5260}
#files{display:flex;flex-direction:column;gap:18px;padding:12px}
</style>
</head>
<body>
<div id="status">Loading the diff renderer...</div>
<div id="files"></div>
<script>window.__lavishDiffModuleUrl=${JSON.stringify(moduleUrl)};</script>
<script src="/editor-diff-frame.js"></script>
</body>
</html>`;
}

/**
 * Split a path so the directory can dim and the file name stay legible, matching the review
 * chrome's own file control.
 * @param {string} file
 */
export function displayPathParts(file) {
  const value = String(file || "");
  const index = value.lastIndexOf("/");
  if (index === -1) return { head: "", tail: value };
  return { head: value.slice(0, index + 1), tail: value.slice(index + 1) };
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
