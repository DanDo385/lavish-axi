import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEditorPreviewDocument,
  classifyEditorSource,
  editorAssetRefs,
  editorSourceKind,
  isEditableEditorState,
  isLocalArtifactUrl,
  MAX_EDITOR_FILE_BYTES,
  normalizeEditorRelPath,
} from "../src/editor-preview.js";

const ARTIFACT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="styles.css">
<link rel="icon" href="favicon.png">
<link rel="stylesheet" href="https://cdn.example.com/x.css">
</head>
<body>
<h1>Demo</h1>
<img src="shot.png" alt="">
<script src="app.js"></script>
</body>
</html>
`;

test("normalizeEditorRelPath confines a path to the artifact tree", () => {
  assert.equal(normalizeEditorRelPath("styles.css"), "styles.css");
  assert.equal(normalizeEditorRelPath("./css/app.css?v=2#top"), "css/app.css");
  assert.equal(normalizeEditorRelPath("css/../app.css"), "app.css");
  assert.equal(normalizeEditorRelPath("../secret.css"), "");
  assert.equal(normalizeEditorRelPath("css/../../secret.css"), "");
  assert.equal(normalizeEditorRelPath("/etc/passwd"), "");
  assert.equal(normalizeEditorRelPath("a\\b.css"), "");
  assert.equal(normalizeEditorRelPath("a%00b.css"), "");
  assert.equal(normalizeEditorRelPath(""), "");
});

test("isLocalArtifactUrl accepts only relative in-tree URLs", () => {
  assert.equal(isLocalArtifactUrl("styles.css"), true);
  assert.equal(isLocalArtifactUrl("./nested/styles.css"), true);
  assert.equal(isLocalArtifactUrl("https://cdn.example.com/x.css"), false);
  assert.equal(isLocalArtifactUrl("//cdn.example.com/x.css"), false);
  assert.equal(isLocalArtifactUrl("/styles.css"), false);
  assert.equal(isLocalArtifactUrl("data:text/css,body{}"), false);
  assert.equal(isLocalArtifactUrl("#anchor"), false);
  assert.equal(isLocalArtifactUrl("../outside.css"), false);
});

test("editorSourceKind maps only HTML, CSS, and JS extensions", () => {
  assert.equal(editorSourceKind("index.html"), "html");
  assert.equal(editorSourceKind("page.htm"), "html");
  assert.equal(editorSourceKind("styles.CSS"), "css");
  assert.equal(editorSourceKind("app.js"), "js");
  assert.equal(editorSourceKind("app.mjs"), "js");
  assert.equal(editorSourceKind("data.json"), "");
  assert.equal(editorSourceKind("shot.png"), "");
  assert.equal(editorSourceKind("Makefile"), "");
});

test("editorAssetRefs finds in-tree stylesheets and scripts and skips everything else", () => {
  const refs = editorAssetRefs(ARTIFACT);
  assert.deepEqual(
    refs.map((ref) => [ref.kind, ref.rel]),
    [
      ["css", "styles.css"],
      ["js", "app.js"],
    ],
  );
  const [stylesheet] = refs;
  assert.equal(
    ARTIFACT.slice(stylesheet.startOffset, stylesheet.endOffset),
    '<link rel="stylesheet" href="styles.css">',
  );
});

test("editorAssetRefs ignores a </script> that is only character data", () => {
  const html = `<body><script src="app.js"></script><script>const s = "</script>";</script></body>`;
  const refs = editorAssetRefs(html);
  assert.deepEqual(
    refs.map((ref) => ref.rel),
    ["app.js"],
  );
});

test("editorAssetRefs skips a script whose type is data rather than source", () => {
  const html = `<body><script type="application/json" src="data.js"></script><script type="module" src="app.js"></script></body>`;
  assert.deepEqual(
    editorAssetRefs(html).map((ref) => ref.rel),
    ["app.js"],
  );
});

test("buildEditorPreviewDocument inlines draft sources and leaves the rest byte-identical", () => {
  const preview = buildEditorPreviewDocument({
    html: ARTIFACT,
    baseHref: "/artifact/abc123/",
    overrides: [
      { rel: "styles.css", kind: "css", contents: "body { color: red }" },
      { rel: "app.js", kind: "js", contents: "console.log('draft')" },
    ],
  });

  assert.match(preview, /<head><base href="\/artifact\/abc123\/">/);
  assert.match(preview, /<style data-lavish-editor-draft="styles\.css">body \{ color: red \}<\/style>/);
  assert.match(preview, /<script data-lavish-editor-draft="app\.js">console\.log\('draft'\)<\/script>/);
  // Untouched markup, including the references the panes do not own.
  assert.match(preview, /<link rel="icon" href="favicon\.png">/);
  assert.match(preview, /<link rel="stylesheet" href="https:\/\/cdn\.example\.com\/x\.css">/);
  assert.match(preview, /<img src="shot\.png" alt="">/);
  assert.match(preview, /^<!doctype html>/);
  // No draft for a file means the artifact's own element survives.
  const htmlOnly = buildEditorPreviewDocument({ html: ARTIFACT, baseHref: "/artifact/abc123/" });
  assert.match(htmlOnly, /<link rel="stylesheet" href="styles\.css">/);
  assert.match(htmlOnly, /<script src="app\.js"><\/script>/);
});

test("buildEditorPreviewDocument escapes a closing tag inside inlined draft text", () => {
  const preview = buildEditorPreviewDocument({
    html: `<head><link rel="stylesheet" href="s.css"></head><body><script src="a.js"></script></body>`,
    overrides: [
      { rel: "s.css", contents: "/* </style> */ body{}" },
      { rel: "a.js", contents: `const end = "</script>";` },
    ],
  });
  assert.match(preview, /\/\* <\\\/style> \*\/ body\{\}/);
  assert.match(preview, /const end = "<\\\/script>";/);
  // Exactly one style and one script element survive the inlining.
  assert.equal(preview.match(/<\/style>/g).length, 1);
  assert.equal(preview.match(/<\/script>/g).length, 1);
});

test("buildEditorPreviewDocument never previews a draft through an escaping or absolute URL", () => {
  const html = `<head><link rel="stylesheet" href="../outside.css"><link rel="stylesheet" href="https://cdn.example.com/x.css"></head>`;
  const preview = buildEditorPreviewDocument({
    html,
    overrides: [
      { rel: "outside.css", contents: "body{}" },
      { rel: "x.css", contents: "body{}" },
    ],
  });
  assert.equal(preview.includes("<style"), false);
});

test("buildEditorPreviewDocument places base after the doctype when the artifact has no head", () => {
  const preview = buildEditorPreviewDocument({ html: `<!doctype html><p>bare</p>`, baseHref: "/artifact/k/" });
  assert.match(preview, /^<!doctype html><base href="\/artifact\/k\/"><p>bare<\/p>$/);

  const fragment = buildEditorPreviewDocument({ html: `<p>bare</p>`, baseHref: "/artifact/k/" });
  assert.match(fragment, /^<base href="\/artifact\/k\/"><p>bare<\/p>$/);
});

test("buildEditorPreviewDocument escapes a quote in the base href", () => {
  const preview = buildEditorPreviewDocument({ html: "<head></head>", baseHref: '/artifact/a"b/' });
  assert.match(preview, /<base href="\/artifact\/a&quot;b\/">/);
});

test("classifyEditorSource separates text, empty, binary, and oversized files", () => {
  assert.deepEqual(classifyEditorSource(Buffer.from("body{}", "utf8")), {
    state: "text",
    text: "body{}",
    bytes: 6,
  });
  assert.deepEqual(classifyEditorSource(Buffer.from("  \n", "utf8")), { state: "empty", text: "  \n", bytes: 3 });
  assert.equal(classifyEditorSource(Buffer.from([0x50, 0x4b, 0x00, 0x01])).state, "binary");
  assert.equal(classifyEditorSource(Buffer.from([0xff, 0xfe, 0xfd])).state, "binary");
  assert.equal(classifyEditorSource(Buffer.alloc(MAX_EDITOR_FILE_BYTES + 1, 0x61)).state, "too-large");
  assert.equal(classifyEditorSource(Buffer.alloc(MAX_EDITOR_FILE_BYTES + 1, 0x61)).text, "");
});

test("isEditableEditorState allows text and empty only", () => {
  assert.equal(isEditableEditorState("text"), true);
  assert.equal(isEditableEditorState("empty"), true);
  assert.equal(isEditableEditorState("binary"), false);
  assert.equal(isEditableEditorState("too-large"), false);
});
