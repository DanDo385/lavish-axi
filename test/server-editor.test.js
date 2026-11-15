import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { isEditorApiPath, MAX_EDITOR_SOURCES, serve } from "../src/server.js";
import { MAX_EDITOR_FILE_BYTES } from "../src/editor-preview.js";

const ARTIFACT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Editable demo</title>
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="https://cdn.example.com/x.css">
</head>
<body>
<h1>Demo</h1>
<img src="shot.png" alt="">
<script src="app.js"></script>
</body>
</html>
`;

async function startEditorServer({ html = ARTIFACT_HTML, extras = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-editor-"));
  const artifactDir = path.join(dir, "artifact");
  await mkdir(artifactDir, { recursive: true });
  const artifact = path.join(artifactDir, "index.html");
  await writeFile(artifact, html);
  await writeFile(path.join(artifactDir, "styles.css"), "body { color: rebeccapurple }\n");
  await writeFile(path.join(artifactDir, "app.js"), "console.log('saved');\n");
  for (const [name, contents] of Object.entries(extras)) {
    await writeFile(path.join(artifactDir, name), contents);
  }
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
  });
  const base = `http://127.0.0.1:${server.port}`;
  const opened = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: artifact }),
  }).then((res) => res.json());
  return {
    dir,
    artifactDir,
    artifact,
    base,
    key: opened.key,
    server,
    sameOrigin: { "content-type": "application/json", origin: base },
    sources: () => fetch(`${base}/api/${opened.key}/editor/sources`).then((res) => res.json()),
    save: (body) =>
      fetch(`${base}/api/${opened.key}/editor/source`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify(body),
      }),
    preview: (body, headers = { "content-type": "application/json", origin: base }) =>
      fetch(`${base}/api/${opened.key}/editor/preview`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("isEditorApiPath matches only the editor's own JSON-bodied routes", () => {
  assert.equal(isEditorApiPath("/api/0123456789abcdef/editor/source"), true);
  assert.equal(isEditorApiPath("/api/0123456789abcdef/editor/preview"), true);
  assert.equal(isEditorApiPath("/api/0123456789abcdef/editor/sources"), false);
  assert.equal(isEditorApiPath("/api/0123456789abcdef/prompts"), false);
  assert.equal(isEditorApiPath("/api/NOTHEX/editor/source"), false);
  assert.equal(isEditorApiPath("/editor/0123456789abcdef"), false);
});

test("the editor page is served, refuses to be framed, and carries no third-party code", async (t) => {
  const harness = await startEditorServer();
  t.after(() => harness.close());

  const response = await fetch(`${harness.base}/editor/${harness.key}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");
  const html = await response.text();
  assert.match(html, /<script src="\/editor-client\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/editor\.css">/);
  assert.match(html, /id="previewFrame"[^>]*sandbox="allow-scripts allow-forms allow-popups/);
  // The page that may write files never loads anything off this machine.
  assert.equal(html.includes("esm.sh"), false);
  assert.equal(html.includes("/sdk.js"), false);

  assert.equal((await fetch(`${harness.base}/editor/0123456789abcdef`)).status, 404);
});

test("the review chrome links to the editor for its own session", async (t) => {
  const harness = await startEditorServer();
  t.after(() => harness.close());
  const chrome = await fetch(`${harness.base}/session/${harness.key}`).then((res) => res.text());
  assert.match(chrome, new RegExp(`href="/editor/${harness.key}"`));
});

test("the editor's browser files are served raw", async (t) => {
  const harness = await startEditorServer();
  t.after(() => harness.close());
  for (const [route, type] of [
    ["/editor-client.js", "application/javascript"],
    ["/editor.css", "text/css"],
    ["/editor-diff-frame.js", "application/javascript"],
  ]) {
    const response = await fetch(`${harness.base}${route}`);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-type") || "", new RegExp(type));
  }
});

test("the diff frame is framable and its CSP confines the third-party renderer", async (t) => {
  const harness = await startEditorServer();
  t.after(() => harness.close());
  const response = await fetch(`${harness.base}/editor-diff-frame`);
  assert.equal(response.status, 200);
  // Framed by the editor page, so it must NOT deny framing the way the chrome and editor do.
  assert.equal(response.headers.get("x-frame-options"), null);
  const csp = response.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src [^;]*https:\/\/esm\.sh/);
  // The frame's origin is opaque, so 'self' names nothing: this server's origin is written out.
  assert.match(csp, new RegExp(`script-src [^;]*${harness.base.replace(/[/.]/g, "\\$&")}`));
  assert.match(csp, /connect-src https:\/\/esm\.sh/);
  const html = await response.text();
  assert.match(html, /https:\/\/esm\.sh\/@pierre\/diffs@1\.2\.10\?bundle/);
});

test("sources list the artifact's HTML plus the in-tree CSS and JS it loads", async (t) => {
  const harness = await startEditorServer();
  t.after(() => harness.close());

  const body = await harness.sources();
  assert.equal(body.truncated, false);
  assert.deepEqual(
    body.files.map((file) => [file.kind, file.rel, file.state, file.editable]),
    [
      ["html", "index.html", "text", true],
      ["css", "styles.css", "text", true],
      ["js", "app.js", "text", true],
    ],
  );
  assert.equal(body.files[1].contents, "body { color: rebeccapurple }\n");
  assert.equal(body.max_file_bytes, MAX_EDITOR_FILE_BYTES);

  const manifest = await fetch(`${harness.base}/api/${harness.key}/editor/sources?manifest=1`).then((res) =>
    res.json(),
  );
  assert.equal(manifest.files.length, 3);
  for (const file of manifest.files) {
    assert.equal(file.contents, undefined);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
});

test("sources report a missing, binary, or oversized file read-only instead of editing it", async (t) => {
  const html = `<head><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="gone.css"><link rel="stylesheet" href="blob.css"><link rel="stylesheet" href="huge.css"></head><body></body>`;
  const harness = await startEditorServer({
    html,
    extras: {
      "blob.css": Buffer.from([0x62, 0x6f, 0x64, 0x79, 0x00, 0x7b, 0x7d]),
      "huge.css": Buffer.alloc(MAX_EDITOR_FILE_BYTES + 1, 0x61),
    },
  });
  t.after(() => harness.close());

  const states = Object.fromEntries((await harness.sources()).files.map((file) => [file.rel, file]));
  assert.equal(states["gone.css"].state, "missing");
  assert.equal(states["gone.css"].editable, false);
  assert.equal(states["blob.css"].state, "binary");
  assert.equal(states["blob.css"].editable, false);
  assert.equal(states["blob.css"].contents, "");
  assert.equal(states["huge.css"].state, "too-large");
  assert.equal(states["huge.css"].editable, false);
  assert.equal(states["styles.css"].state, "text");

  // A read-only file is also refused a write, whatever the pane claims.
  assert.equal((await harness.save({ path: "blob.css", contents: "body{}", overwrite: true })).status, 409);
  assert.equal((await harness.save({ path: "huge.css", contents: "body{}", overwrite: true })).status, 409);
  assert.equal((await harness.save({ path: "gone.css", contents: "body{}", overwrite: true })).status, 404);
});

test("sources report truncation rather than silently showing a subset", async (t) => {
  const links = [];
  const extras = {};
  for (let index = 0; index < MAX_EDITOR_SOURCES + 3; index += 1) {
    links.push(`<link rel="stylesheet" href="s${index}.css">`);
    extras[`s${index}.css`] = `/* ${index} */\n`;
  }
  const harness = await startEditorServer({ html: `<head>${links.join("")}</head><body></body>`, extras });
  t.after(() => harness.close());

  const body = await harness.sources();
  assert.equal(body.files.length, MAX_EDITOR_SOURCES);
  assert.equal(body.truncated, true);
});

test("sources refuse a foreign-origin reader and an unknown session", async (t) => {
  const harness = await startEditorServer();
  t.after(() => harness.close());

  const foreign = await fetch(`${harness.base}/api/${harness.key}/editor/sources`, {
    headers: { origin: "http://evil.example" },
  });
  assert.equal(foreign.status, 403);
  assert.equal((await fetch(`${harness.base}/api/0123456789abcdef/editor/sources`)).status, 404);
});

test("preview inlines the draft, keeps the rest of the artifact, and stays inert", async (t) => {
  const harness = await startEditorServer();
  t.after(() => harness.close());

  const response = await harness.preview({
    html: ARTIFACT_HTML.replace("<h1>Demo</h1>", "<h1>Draft</h1>"),
    overrides: [{ rel: "styles.css", contents: "body { color: red }" }],
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/plain/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const preview = await response.text();
  assert.match(preview, new RegExp(`<base href="/artifact/${harness.key}/">`));
  assert.match(preview, /<h1>Draft<\/h1>/);
  assert.match(preview, /<style data-lavish-editor-draft="styles\.css">body \{ color: red \}<\/style>/);
  // Not replaced: the artifact's own remote stylesheet, its image, and its script.
  assert.match(preview, /<link rel="stylesheet" href="https:\/\/cdn\.example\.com\/x\.css">/);
  assert.match(preview, /<script src="app\.js"><\/script>/);
  // The preview is artifact content, so it never carries the Lavish SDK or any bridge to the agent.
  assert.equal(preview.includes("/sdk.js"), false);
});

test("preview falls back to the saved HTML and refuses a cross-origin or oversized request", async (t) => {
  const harness = await startEditorServer();
  t.after(() => harness.close());

  const saved = await harness.preview({}).then((res) => res.text());
  assert.match(saved, /<h1>Demo<\/h1>/);

  const foreign = await harness.preview({}, { "content-type": "application/json", origin: "http://evil.example" });
  assert.equal(foreign.status, 403);

  const headerless = await fetch(`${harness.base}/api/${harness.key}/editor/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(headerless.status, 403);

  const oversized = await harness.preview({ html: "a".repeat(MAX_EDITOR_FILE_BYTES + 1) });
  assert.equal(oversized.status, 413);
});

test("a save writes the file only when the caller names the bytes it is replacing", async (t) => {
  const harness = await startEditorServer();
  t.after(() => harness.close());

  const before = (await harness.sources()).files.find((file) => file.rel === "styles.css");
  const stale = await harness.save({ path: "styles.css", contents: "body{}", base_sha256: "0".repeat(64) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).status, "stale");
  assert.equal(await readFile(path.join(harness.artifactDir, "styles.css"), "utf8"), "body { color: rebeccapurple }\n");

  const saved = await harness.save({
    path: "styles.css",
    contents: "body { color: teal }\n",
    base_sha256: before.sha256,
  });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.status, "saved");
  assert.match(body.sha256, /^[0-9a-f]{64}$/);
  assert.equal(await readFile(path.join(harness.artifactDir, "styles.css"), "utf8"), "body { color: teal }\n");

  // The explicit overwrite is the only way past a stale base, and the editor asks for it in words.
  const overwritten = await harness.save({ path: "styles.css", contents: "body{}\n", overwrite: true });
  assert.equal(overwritten.status, 200);
});

test("a save is refused outside the artifact tree, cross-origin, or for a file the editor does not own", async (t) => {
  const harness = await startEditorServer();
  t.after(() => harness.close());
  const outside = path.join(harness.dir, "outside.css");
  await writeFile(outside, "body{}\n");
  await symlink(outside, path.join(harness.artifactDir, "link.css"));

  const crossOrigin = await fetch(`${harness.base}/api/${harness.key}/editor/source`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ path: "styles.css", contents: "body{}", overwrite: true }),
  });
  assert.equal(crossOrigin.status, 403);

  const headerless = await fetch(`${harness.base}/api/${harness.key}/editor/source`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "styles.css", contents: "body{}", overwrite: true }),
  });
  assert.equal(headerless.status, 403);

  assert.equal((await harness.save({ path: "../outside.css", contents: "x", overwrite: true })).status, 400);
  assert.equal((await harness.save({ path: "/etc/hosts", contents: "x", overwrite: true })).status, 400);
  assert.equal((await harness.save({ path: "notes.txt", contents: "x", overwrite: true })).status, 400);
  assert.equal((await harness.save({ path: "data.json", contents: "x", overwrite: true })).status, 400);
  // A symlink inside the tree that points out of it is refused by the same realpath confinement
  // the artifact asset route uses.
  assert.equal((await harness.save({ path: "link.css", contents: "hacked", overwrite: true })).status, 403);
  assert.equal(await readFile(outside, "utf8"), "body{}\n");

  const oversized = await harness.save({
    path: "styles.css",
    contents: "a".repeat(MAX_EDITOR_FILE_BYTES + 1),
    overwrite: true,
  });
  assert.equal(oversized.status, 413);
});

test("an editor save keeps the served artifact identical to the file on disk", async (t) => {
  const harness = await startEditorServer();
  t.after(() => harness.close());

  const edited = ARTIFACT_HTML.replace("<h1>Demo</h1>", "<h1>Edited by hand</h1>");
  const before = (await harness.sources()).files.find((file) => file.rel === "index.html");
  assert.equal((await harness.save({ path: "index.html", contents: edited, base_sha256: before.sha256 })).status, 200);
  assert.equal(await readFile(harness.artifact, "utf8"), edited);

  const chromeLoad = await fetch(`${harness.base}/api/${harness.key}/chrome-loads/begin`, {
    method: "POST",
    headers: harness.sameOrigin,
    body: "{}",
  }).then((res) => res.json());
  const load = await fetch(`${harness.base}/api/${harness.key}/artifact-loads/begin`, {
    method: "POST",
    headers: harness.sameOrigin,
    body: JSON.stringify({ chrome_load_token: chromeLoad.chrome_load_token }),
  }).then((res) => res.json());
  const served = await fetch(
    `${harness.base}/artifact/${harness.key}/index.html?artifact_load_token=${encodeURIComponent(load.artifact_load_token)}&artifact_revision=${load.artifact_revision}`,
  ).then((res) => res.text());

  // Still the file on disk plus exactly one SDK tag, which is the whole point: the editor writes
  // the artifact, and the artifact route keeps serving bytes identical to what is on disk.
  assert.equal((served.match(/<script src="\/sdk\.js[^"]*"><\/script>/g) || []).length, 1);
  assert.equal(served.replace(/<script src="\/sdk\.js[^"]*"><\/script>/, ""), edited);
});

test("an editor save queues no feedback and never wakes a poll", async (t) => {
  const harness = await startEditorServer();
  t.after(() => harness.close());

  const before = (await harness.sources()).files.find((file) => file.rel === "styles.css");
  await harness.save({ path: "styles.css", contents: "body { color: olive }\n", base_sha256: before.sha256 });

  const poll = await fetch(`${harness.base}/api/poll?key=${harness.key}&timeout_ms=150`).then((res) => res.json());
  assert.notEqual(poll.status, "feedback");
  assert.equal(Array.isArray(poll.prompts) && poll.prompts.length > 0, false);
});
