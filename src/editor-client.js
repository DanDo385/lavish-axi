/* global document, window, CSS */

// The editor page's client. Served as a raw file like `src/chrome-client.js`, so it cannot import
// modules: anything it needs from a shared module is computed on the server and handed over.
//
// Two rules are the whole design. A file is written only when the user presses Save (or Cmd/Ctrl+S)
// and a message reaches the agent only when the user presses Send - nothing here writes or sends
// on a timer, on blur, or as a side effect of previewing. And the preview is untrusted artifact
// content: it renders in a sandboxed frame with no Lavish SDK, so it never receives this page's
// authority and cannot reach the agent bridge.

const bootElement = document.getElementById("lavish-editor");
const boot = JSON.parse(bootElement?.textContent || "{}");
const key = String(boot.key || "");
const filePath = String(boot.file || "");
const draftStorageKey = "lavish-axi:editor-draft:" + key;
const diffStyleStorageKey = "lavish-axi:editor-diff-style";
const diffThemeStorageKey = "lavish-axi:editor-diff-theme";
// Viewer-wide, like the review chrome's panel collapse: a reader who wants the full width for code
// wants it for the next artifact too.
const previewHiddenStorageKey = "lavish-axi:editor-preview-hidden";

const PREVIEW_DEBOUNCE_MS = 400;
const DRAFT_PERSIST_DEBOUNCE_MS = 250;
const DIFF_TAB = "__diff__";

const statusEl = /** @type {HTMLSpanElement} */ (document.getElementById("editorStatus"));
const tabsEl = /** @type {HTMLDivElement} */ (document.getElementById("editorTabs"));
const panesEl = /** @type {HTMLDivElement} */ (document.getElementById("editorPanes"));
const saveButton = /** @type {HTMLButtonElement} */ (document.getElementById("editorSave"));
const previewFrame = /** @type {HTMLIFrameElement} */ (document.getElementById("previewFrame"));
const previewRefresh = /** @type {HTMLButtonElement} */ (document.getElementById("previewRefresh"));
const previewToggle = /** @type {HTMLButtonElement} */ (document.getElementById("previewToggle"));
const noteForm = /** @type {HTMLFormElement} */ (document.getElementById("editorNoteForm"));
const noteInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("editorNote"));
const noteSend = /** @type {HTMLButtonElement} */ (document.getElementById("editorNoteSend"));

/** @type {any[]} */
let sources = [];
/** @type {Map<string, any>} */
const byRel = new Map();
let activeTab = "";
let diffFrameReady = false;
let previewTimer;
let draftTimer;
let saving = false;
/** @type {HTMLButtonElement | null} */
let activeRevert = null;

function setStatus(text, tone) {
  statusEl.textContent = text || "";
  statusEl.dataset.tone = tone || "";
}

function baseName(rel) {
  const parts = String(rel).split("/");
  return parts[parts.length - 1] || rel;
}

function readStoredDrafts() {
  try {
    const raw = sessionStorage.getItem(draftStorageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// The draft is the user's own writing, so it survives a reload of this page. It is stored with the
// hash it was written against: a file the agent rewrote underneath it keeps the draft and reports
// the divergence rather than silently discarding either side.
function persistDrafts() {
  const payload = {};
  for (const source of sources) {
    if (!source.editable) continue;
    if (source.draft === source.saved) continue;
    payload[source.rel] = { text: source.draft, base: source.sha256 };
  }
  try {
    if (Object.keys(payload).length === 0) sessionStorage.removeItem(draftStorageKey);
    else sessionStorage.setItem(draftStorageKey, JSON.stringify(payload));
  } catch {
    // Storage refusing a write must never block editing; the in-memory draft is still authoritative
    // for this page.
  }
}

function schedulePersistDrafts() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(persistDrafts, DRAFT_PERSIST_DEBOUNCE_MS);
}

function dirtySources() {
  return sources.filter((source) => source.editable && source.draft !== source.saved);
}

function describeBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return Math.round(value / 1024) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

function stateNote(source) {
  if (source.state === "binary") return "This file is not UTF-8 text, so it is shown read-only.";
  if (source.state === "too-large")
    return "This file is larger than the editor's " + describeBytes(boot.maxFileBytes) + " limit, so it is read-only.";
  if (source.state === "missing") return "This file is referenced by the artifact but is not on disk.";
  if (source.state === "empty") return "This file is empty.";
  return "";
}

function render() {
  renderTabs();
  renderPanes();
  renderSaveState();
}

function renderTabs() {
  tabsEl.replaceChildren();
  for (const source of sources) {
    tabsEl.append(createTab(source.rel, baseName(source.rel), source.kind.toUpperCase()));
  }
  tabsEl.append(createTab(DIFF_TAB, "Diff", ""));
}

function createTab(id, label, badge) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "editor-tab";
  button.id = "tab-" + encodeURIComponent(id);
  button.setAttribute("role", "tab");
  button.dataset.tab = id;
  const selected = id === activeTab;
  button.setAttribute("aria-selected", selected ? "true" : "false");
  button.setAttribute("aria-controls", "pane-" + encodeURIComponent(id));
  button.tabIndex = selected ? 0 : -1;
  const text = document.createElement("span");
  text.textContent = label;
  button.append(text);
  if (badge) {
    const badgeEl = document.createElement("span");
    badgeEl.className = "editor-tab-kind";
    badgeEl.textContent = badge;
    button.append(badgeEl);
  }
  const source = byRel.get(id);
  if (source && source.editable && source.draft !== source.saved) {
    const dot = document.createElement("span");
    dot.className = "editor-tab-dirty";
    dot.title = "Unsaved changes";
    dot.setAttribute("aria-label", "unsaved changes");
    button.append(dot);
  }
  if (id === DIFF_TAB) {
    const count = dirtySources().length;
    if (count > 0) {
      const badgeEl = document.createElement("span");
      badgeEl.className = "editor-tab-count";
      badgeEl.textContent = String(count);
      button.append(badgeEl);
    }
  }
  button.addEventListener("click", () => selectTab(id));
  return button;
}

function renderPanes() {
  activeRevert = null;
  panesEl.replaceChildren();
  const source = byRel.get(activeTab);
  if (activeTab === DIFF_TAB || !source) {
    panesEl.append(createDiffPane());
    return;
  }
  panesEl.append(createSourcePane(source));
}

function createSourcePane(source) {
  const pane = document.createElement("div");
  pane.className = "editor-pane";
  pane.id = "pane-" + encodeURIComponent(source.rel);
  pane.setAttribute("role", "tabpanel");
  pane.setAttribute("aria-labelledby", "tab-" + encodeURIComponent(source.rel));

  const head = document.createElement("div");
  head.className = "editor-pane-head";
  const path = document.createElement("span");
  path.className = "editor-pane-path";
  path.textContent = source.rel;
  const meta = document.createElement("span");
  meta.className = "editor-pane-meta";
  meta.textContent = describeBytes(source.bytes) + " on disk";
  head.append(path, meta);
  if (source.editable) {
    // Created up front and shown the moment the pane goes dirty: re-rendering the pane on every
    // keystroke would destroy the textarea the user is typing in.
    const revert = document.createElement("button");
    revert.type = "button";
    revert.className = "editor-ghost";
    revert.textContent = "Discard changes";
    revert.hidden = source.draft === source.saved;
    revert.addEventListener("click", () => {
      source.draft = source.saved;
      persistDrafts();
      render();
      schedulePreview();
      setStatus("Discarded unsaved changes to " + source.rel);
    });
    head.append(revert);
    activeRevert = revert;
  }
  pane.append(head);

  const note = stateNote(source);
  if (note) {
    const noteEl = document.createElement("p");
    noteEl.className = "editor-pane-note";
    noteEl.textContent = note;
    pane.append(noteEl);
  }
  if (source.conflict) {
    pane.append(createConflictNotice(source));
  }

  const textarea = document.createElement("textarea");
  textarea.className = "editor-code";
  textarea.spellcheck = false;
  textarea.setAttribute("wrap", "off");
  textarea.setAttribute("aria-label", source.rel + " source");
  textarea.value = source.editable ? source.draft : "";
  textarea.readOnly = !source.editable;
  if (!source.editable) textarea.placeholder = note;
  textarea.addEventListener("input", () => {
    source.draft = textarea.value;
    schedulePersistDrafts();
    renderTabs();
    renderSaveState();
    schedulePreview();
  });
  pane.append(textarea);
  return pane;
}

function createConflictNotice(source) {
  const box = document.createElement("div");
  box.className = "editor-conflict";
  const text = document.createElement("p");
  text.textContent =
    source.rel +
    " changed on disk after you opened it. Your draft is kept here. Saving now would overwrite the newer file.";
  const actions = document.createElement("div");
  actions.className = "editor-conflict-actions";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "editor-ghost";
  reload.textContent = "Load the file from disk (discards this draft)";
  reload.addEventListener("click", async () => {
    await loadSources({ preserveDrafts: false });
    setStatus("Reloaded " + source.rel + " from disk");
  });
  const overwrite = document.createElement("button");
  overwrite.type = "button";
  overwrite.className = "editor-ghost danger";
  overwrite.textContent = "Overwrite the file with this draft";
  overwrite.addEventListener("click", () => {
    source.overwrite = true;
    setStatus("Save will overwrite " + source.rel, "warn");
    render();
  });
  actions.append(reload, overwrite);
  box.append(text, actions);
  return box;
}

function createDiffPane() {
  const pane = document.createElement("div");
  pane.className = "editor-pane editor-pane-diff";
  pane.id = "pane-" + encodeURIComponent(DIFF_TAB);
  pane.setAttribute("role", "tabpanel");
  pane.setAttribute("aria-labelledby", "tab-" + encodeURIComponent(DIFF_TAB));

  const head = document.createElement("div");
  head.className = "editor-pane-head";
  const title = document.createElement("span");
  title.className = "editor-pane-path";
  title.textContent = "Unsaved changes against the files on disk";
  head.append(title);
  head.append(
    createChoice(
      "Layout",
      diffStyle(),
      [
        ["split", "Split"],
        ["unified", "Unified"],
      ],
      (value) => {
        store(diffStyleStorageKey, value);
        sendDiff();
      },
    ),
  );
  head.append(
    createChoice(
      "Theme",
      diffTheme(),
      [
        ["dark", "Dark"],
        ["light", "Light"],
      ],
      (value) => {
        store(diffThemeStorageKey, value);
        sendDiff();
      },
    ),
  );
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "editor-ghost";
  refresh.textContent = "Refresh";
  refresh.addEventListener("click", () => sendDiff());
  head.append(refresh);
  pane.append(head);

  const note = document.createElement("p");
  note.className = "editor-pane-note";
  note.textContent =
    "Rendered by @pierre/diffs, loaded on demand from esm.sh into a sandboxed frame. That frame sees only the text below; it cannot write files or reach your agent.";
  pane.append(note);

  const frame = document.createElement("iframe");
  frame.id = "diffFrame";
  frame.className = "editor-diff-frame";
  frame.title = "Diff";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.src = "/editor-diff-frame";
  diffFrameReady = false;
  pane.append(frame);
  return pane;
}

function createChoice(label, value, options, onChange) {
  const group = document.createElement("div");
  group.className = "editor-choice";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  for (const [optionValue, optionLabel] of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor-choice-option";
    button.textContent = optionLabel;
    button.setAttribute("aria-pressed", optionValue === value ? "true" : "false");
    button.addEventListener("click", () => {
      onChange(optionValue);
      for (const sibling of group.children) sibling.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
    });
    group.append(button);
  }
  return group;
}

function store(storageKey, value) {
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    // A refused preference write only costs the choice its persistence.
  }
}

function read(storageKey, fallback) {
  try {
    return localStorage.getItem(storageKey) || fallback;
  } catch {
    return fallback;
  }
}

function diffStyle() {
  return read(diffStyleStorageKey, "split") === "unified" ? "unified" : "split";
}

function diffTheme() {
  return read(diffThemeStorageKey, "dark") === "light" ? "light" : "dark";
}

function renderSaveState() {
  const dirty = dirtySources();
  const active = byRel.get(activeTab);
  if (activeRevert) activeRevert.hidden = !active || !active.editable || active.draft === active.saved;
  saveButton.disabled = saving || dirty.length === 0;
  saveButton.textContent =
    dirty.length === 0 ? "Save to disk" : dirty.length === 1 ? "Save 1 file" : "Save " + dirty.length + " files";
  if (activeTab === DIFF_TAB) sendDiff();
}

function selectTab(id) {
  if (activeTab === id) return;
  activeTab = id;
  render();
  if (id === DIFF_TAB) return;
  const textarea = /** @type {HTMLTextAreaElement | null} */ (panesEl.querySelector("textarea"));
  if (textarea) textarea.focus();
}

function tabIds() {
  return sources.map((source) => source.rel).concat([DIFF_TAB]);
}

tabsEl.addEventListener("keydown", (event) => {
  const ids = tabIds();
  const index = ids.indexOf(activeTab);
  let next = -1;
  if (event.key === "ArrowRight") next = (index + 1) % ids.length;
  else if (event.key === "ArrowLeft") next = (index - 1 + ids.length) % ids.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = ids.length - 1;
  if (next === -1) return;
  event.preventDefault();
  selectTab(ids[next]);
  const button = /** @type {HTMLButtonElement | null} */ (
    tabsEl.querySelector('[data-tab="' + CSS.escape(ids[next]) + '"]')
  );
  if (button) button.focus();
});

async function loadSources({ preserveDrafts = true } = {}) {
  setStatus("Loading sources...");
  let payload;
  try {
    const response = await fetch("/api/" + key + "/editor/sources");
    if (!response.ok) throw new Error("HTTP " + response.status);
    payload = await response.json();
  } catch (error) {
    setStatus("Could not read the artifact's sources: " + describeError(error), "error");
    return;
  }
  const stored = preserveDrafts ? readStoredDrafts() : {};
  sources = (payload.files || []).map((file) => {
    const draft = stored[file.rel];
    const hasDraft = file.editable && draft && typeof draft.text === "string" && draft.text !== file.contents;
    return {
      rel: String(file.rel),
      kind: String(file.kind),
      state: String(file.state),
      bytes: Number(file.bytes) || 0,
      sha256: String(file.sha256 || ""),
      editable: Boolean(file.editable),
      saved: String(file.contents || ""),
      draft: hasDraft ? draft.text : String(file.contents || ""),
      // A draft written against a hash the file no longer has is a real divergence the user has to
      // resolve; it is never resolved for them by dropping one side.
      conflict: Boolean(hasDraft && draft.base && draft.base !== file.sha256),
      overwrite: false,
    };
  });
  byRel.clear();
  for (const source of sources) byRel.set(source.rel, source);
  if (!byRel.has(activeTab) && activeTab !== DIFF_TAB) activeTab = sources.length > 0 ? sources[0].rel : DIFF_TAB;
  persistDrafts();
  render();
  schedulePreview();
  const conflicts = sources.filter((source) => source.conflict).length;
  if (conflicts > 0) setStatus(conflicts + (conflicts === 1 ? " file" : " files") + " changed on disk", "warn");
  else if (payload.truncated) setStatus("Showing the first " + sources.length + " sources this artifact loads", "warn");
  else setStatus(filePath ? "Editing " + baseName(filePath) : "");
}

// Saving is the one path that writes to disk, and only a click or Cmd/Ctrl+S reaches it.
async function saveAll() {
  const dirty = dirtySources();
  if (saving || dirty.length === 0) return;
  saving = true;
  renderSaveState();
  let saved = 0;
  for (const source of dirty) {
    setStatus("Saving " + source.rel + "...");
    let response;
    try {
      response = await fetch("/api/" + key + "/editor/source", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: source.rel,
          contents: source.draft,
          base_sha256: source.overwrite ? "" : source.sha256,
          overwrite: Boolean(source.overwrite),
        }),
      });
    } catch (error) {
      saving = false;
      setStatus("Could not save " + source.rel + ": " + describeError(error), "error");
      render();
      return;
    }
    if (response.status === 409) {
      source.conflict = true;
      saving = false;
      setStatus(source.rel + " changed on disk since you opened it", "warn");
      selectTab(source.rel);
      render();
      return;
    }
    if (!response.ok) {
      const detail = await response
        .json()
        .then((body) => String(body.error || ""))
        .catch(() => "");
      saving = false;
      setStatus("Could not save " + source.rel + ": " + (detail || "HTTP " + response.status), "error");
      render();
      return;
    }
    const body = await response.json().catch(() => ({}));
    source.saved = source.draft;
    source.sha256 = String(body.sha256 || "");
    source.bytes = Number(body.bytes) || source.bytes;
    source.state = source.draft.trim() === "" ? "empty" : "text";
    source.conflict = false;
    source.overwrite = false;
    saved += 1;
  }
  saving = false;
  persistDrafts();
  render();
  setStatus(saved === 1 ? "Saved 1 file" : "Saved " + saved + " files", "ok");
}

saveButton.addEventListener("click", saveAll);

document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "s" && event.key !== "S") return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    saveAll();
  },
  true,
);

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, PREVIEW_DEBOUNCE_MS);
}

// Previewing writes nothing: the server builds the document from the draft it is handed and the
// frame renders it in an opaque origin. The draft reaches disk only through Save.
async function refreshPreview() {
  if (document.body.classList.contains("preview-hidden")) return;
  const html = sources.find((source) => source.kind === "html");
  if (!html) return;
  const overrides = sources
    .filter((source) => source.kind !== "html" && source.editable && source.draft !== source.saved)
    .map((source) => ({ rel: source.rel, contents: source.draft }));
  try {
    const response = await fetch("/api/" + key + "/editor/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: html.draft, overrides }),
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    previewFrame.srcdoc = await response.text();
  } catch (error) {
    setStatus("Could not build the preview: " + describeError(error), "error");
  }
}

previewRefresh.addEventListener("click", () => {
  clearTimeout(previewTimer);
  refreshPreview();
});

function applyPreviewVisibility(hidden) {
  document.body.classList.toggle("preview-hidden", hidden);
  previewToggle.textContent = hidden ? "Show preview" : "Hide preview";
  previewToggle.setAttribute("aria-expanded", hidden ? "false" : "true");
}

previewToggle.addEventListener("click", () => {
  const hidden = !document.body.classList.contains("preview-hidden");
  store(previewHiddenStorageKey, hidden ? "1" : "0");
  applyPreviewVisibility(hidden);
  if (!hidden) schedulePreview();
});

applyPreviewVisibility(read(previewHiddenStorageKey, "0") === "1");

function sendDiff() {
  if (activeTab !== DIFF_TAB || !diffFrameReady) return;
  const frame = /** @type {HTMLIFrameElement | null} */ (document.getElementById("diffFrame"));
  if (!frame || !frame.contentWindow) return;
  frame.contentWindow.postMessage(
    {
      type: "lavish:renderDiff",
      diffStyle: diffStyle(),
      themeType: diffTheme(),
      files: dirtySources().map((source) => ({
        name: source.rel,
        oldContents: source.saved,
        newContents: source.draft,
      })),
    },
    "*",
  );
}

window.addEventListener("message", (event) => {
  const frame = /** @type {HTMLIFrameElement | null} */ (document.getElementById("diffFrame"));
  // The diff frame is opaque-origin, so identity is the window handle, not the origin string.
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || typeof data.type !== "string") return;
  if (data.type === "lavish:diffFrameReady") {
    diffFrameReady = true;
    sendDiff();
    return;
  }
  if (data.type === "lavish:diffFailed") setStatus("The diff renderer could not be loaded", "warn");
});

noteInput.addEventListener("input", () => {
  noteSend.disabled = noteInput.value.trim() === "";
});

// Prompt submission is explicit, like every write. Nothing about saving, previewing, or diffing
// queues feedback for the agent.
noteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = noteInput.value.trim();
  if (!text) return;
  noteSend.disabled = true;
  try {
    const response = await fetch("/api/" + key + "/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompts: [{ prompt: text, tag: "editor", text }] }),
    });
    if (!response.ok) {
      const detail = await response
        .json()
        .then((body) => String(body.error || ""))
        .catch(() => "");
      setStatus("Could not send the message: " + (detail || "HTTP " + response.status), "error");
      noteSend.disabled = false;
      return;
    }
    noteInput.value = "";
    setStatus("Sent to the agent", "ok");
  } catch (error) {
    setStatus("Could not send the message: " + describeError(error), "error");
    noteSend.disabled = false;
  }
});

// Coming back to this tab is when a file the agent rewrote is most likely to have moved under an
// open draft, so re-read the hashes then rather than polling.
window.addEventListener("focus", () => {
  refreshDiskState();
});

async function refreshDiskState() {
  if (saving) return;
  let payload;
  try {
    const response = await fetch("/api/" + key + "/editor/sources?manifest=1");
    if (!response.ok) return;
    payload = await response.json();
  } catch {
    return;
  }
  let changed = 0;
  for (const file of payload.files || []) {
    const source = byRel.get(String(file.rel));
    if (!source || source.sha256 === String(file.sha256 || "")) continue;
    if (source.draft === source.saved) {
      // Nothing of the user's is at stake, so adopt the newer file.
      await loadSources({ preserveDrafts: true });
      return;
    }
    source.conflict = true;
    changed += 1;
  }
  if (changed > 0) {
    setStatus(changed + (changed === 1 ? " file" : " files") + " changed on disk", "warn");
    render();
  }
}

function describeError(error) {
  return String(error && error.message ? error.message : error);
}

if (!key) setStatus("This editor page has no session.", "error");
else loadSources();
