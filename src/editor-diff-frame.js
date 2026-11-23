/* global document, window */

// The diff renderer, isolated in an opaque-origin frame.
//
// `@pierre/diffs` is loaded at runtime from esm.sh - the no-build form the `code` playbook in
// `src/playbooks.js` verifies and mandates for code surfaces - rather than bundled into Lavish.
// It is third-party code reading the user's own source text, so it runs here instead of on the
// editor page: this document has no same-origin privileges, so it cannot write a file, read the
// editor, or pass the same-origin guard that protects `/api/:key/prompts`, and its response CSP
// lets it talk to nothing but the module host it came from.
//
// It receives file text from the parent over postMessage and renders. It asks for nothing and
// sends nothing back but its own readiness and render outcome.
//
// Served and loaded as a CLASSIC script even though it uses `import()`: a module script fetched by
// this opaque-origin document would be a cross-origin request needing its own CORS header, while a
// classic script needs none. The dynamic import is unaffected - esm.sh answers with
// `Access-Control-Allow-Origin: *`.

const statusEl = document.getElementById("status");
const filesEl = document.getElementById("files");
const theme = { light: "github-light", dark: "github-dark" };

let modulePromise = null;
let renderSeq = 0;

function loadDiffModule() {
  if (!modulePromise) {
    const url = String(/** @type {any} */ (window).__lavishDiffModuleUrl || "");
    modulePromise = import(url).catch((error) => {
      // A failed load must be retryable: a user who reconnects and presses Refresh should not be
      // stuck with the first failure for the life of the page.
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = !text;
}

function post(message) {
  // The parent is same-origin-unknown from here (this document is opaque), so "*" is the only
  // target available. Nothing secret is ever sent: only readiness and render outcome.
  window.parent?.postMessage(message, "*");
}

async function render(payload) {
  const seq = ++renderSeq;
  const files = Array.isArray(payload.files) ? payload.files.slice(0, 32) : [];
  const diffStyle = payload.diffStyle === "unified" ? "unified" : "split";
  const themeType = payload.themeType === "light" ? "light" : "dark";
  document.documentElement.classList.toggle("light", themeType === "light");

  if (files.length === 0) {
    filesEl.replaceChildren();
    setStatus("No unsaved changes. Every pane matches the file on disk.");
    post({ type: "lavish:diffRendered", files: 0 });
    return;
  }

  setStatus("Rendering the diff...");
  let FileDiff;
  try {
    ({ FileDiff } = await loadDiffModule());
  } catch (error) {
    if (seq !== renderSeq) return;
    filesEl.replaceChildren();
    setStatus(
      "The diff renderer could not be loaded from " +
        new URL(String(/** @type {any} */ (window).__lavishDiffModuleUrl || "https://esm.sh")).origin +
        ". It is fetched on demand, so the diff needs a network connection; your edits and the Save button do not. Press Refresh to try again.",
    );
    post({ type: "lavish:diffFailed", message: String(error && error.message ? error.message : error) });
    return;
  }
  if (seq !== renderSeq) return;

  filesEl.replaceChildren();
  for (const file of files) {
    const name = String(file?.name || "file");
    const oldContents = String(file?.oldContents ?? "");
    const newContents = String(file?.newContents ?? "");

    // The renderer draws its own file header with the path and the changed-line counts, so this
    // adds no second one: one header per file, from the library that owns the code surface.
    const section = document.createElement("section");
    filesEl.append(section);

    new FileDiff({ theme, themeType, overflow: "wrap", diffStyle }).render({
      containerWrapper: section,
      oldFile: { name, contents: oldContents },
      newFile: { name, contents: newContents },
    });
  }
  setStatus("");
  post({ type: "lavish:diffRendered", files: files.length });
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.type !== "lavish:renderDiff") return;
  render(data).catch((error) => {
    setStatus("The diff could not be rendered: " + String(error && error.message ? error.message : error));
  });
});

setStatus("");
post({ type: "lavish:diffFrameReady" });
