import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Editor mode in a real browser. The unit and route tests pin the contract on the server side;
// what only a browser can prove is that the panes, the sandboxed preview, and the diff tab behave
// the way the user is told they do - above all that nothing writes a file or reaches the agent
// without an explicit action, and that an unsaved draft survives a reload.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ARTIFACT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Editable artifact</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<h1 id="title">Saved heading</h1>
<script src="app.js"></script>
</body>
</html>
`;

function run(command, args, env, timeout = 60_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

test(
  "editor mode edits, previews, and diffs an artifact in a real browser",
  { skip: !runBrowserE2e, timeout: 420_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-editor-e2e-"));
    const port = await freePort();
    const artifactDir = path.join(temp, "artifact");
    await mkdir(artifactDir, { recursive: true });
    const artifact = path.join(artifactDir, "index.html");
    await writeFile(artifact, ARTIFACT_HTML);
    await writeFile(path.join(artifactDir, "styles.css"), "h1 { color: rebeccapurple }\n");
    await writeFile(path.join(artifactDir, "app.js"), "document.title = document.title;\n");

    // An isolated port and state directory: this worktree's CLI must never adopt, replace, or stop
    // the Lavish server an installed copy is running for someone's open review.
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-editor-e2e-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    function evaluate(expression) {
      const output = run("chrome-devtools-axi", ["eval", expression], chromeEnv);
      const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
      assert.ok(raw, output);
      let value = JSON.parse(raw);
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }

    const wait = (ms) => run("chrome-devtools-axi", ["wait", String(ms)], chromeEnv);

    try {
      const openOutput = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const sessionUrl = openOutput.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(sessionUrl, openOutput);
      const editorUrl = sessionUrl.replace("/session/", "/editor/");

      run("chrome-devtools-axi", ["open", editorUrl], chromeEnv);
      wait(1200);

      // Instrument the diff frame's own reports. Production code sends them; the test only listens.
      evaluate(
        "(() => { window.__diffEvents = []; window.addEventListener('message', (event) => { if (event.data && typeof event.data.type === 'string' && event.data.type.startsWith('lavish:diff')) window.__diffEvents.push(event.data); }); return 'ok'; })()",
      );

      const tabs = () =>
        evaluate(
          "JSON.stringify([...document.querySelectorAll('.editor-tab')].map((tab) => ({ label: tab.textContent, selected: tab.getAttribute('aria-selected'), tabIndex: tab.tabIndex })))",
        );

      const panes = tabs();
      assert.deepEqual(
        panes.map((tab) => tab.label),
        ["index.htmlHTML", "styles.cssCSS", "app.jsJS", "Diff"],
        JSON.stringify(panes),
      );
      assert.equal(panes[0].selected, "true");
      // Only the selected tab is in the tab order; the rest are reached with the arrow keys.
      assert.deepEqual(
        panes.map((tab) => tab.tabIndex),
        [0, -1, -1, -1],
      );

      // Keyboard navigation between panes.
      evaluate(
        "(() => { document.getElementById('editorTabs').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return 'ok'; })()",
      );
      assert.equal(
        evaluate("JSON.stringify(document.querySelector('.editor-tab[aria-selected=\"true\"]').textContent)"),
        "styles.cssCSS",
      );

      // Type a CSS draft that also carries a closing tag, which the preview has to neutralize.
      evaluate(
        "(() => { const area = document.querySelector('.editor-code'); area.value = 'h1 { color: teal } /* </style> */'; area.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()",
      );
      wait(900);

      const dirtyState = evaluate(
        "JSON.stringify({ save: document.getElementById('editorSave').textContent, disabled: document.getElementById('editorSave').disabled, dirtyDots: document.querySelectorAll('.editor-tab-dirty').length, diffCount: document.querySelector('.editor-tab-count')?.textContent || '' })",
      );
      assert.equal(dirtyState.save, "Save 1 file");
      assert.equal(dirtyState.disabled, false);
      assert.equal(dirtyState.dirtyDots, 1);
      assert.equal(dirtyState.diffCount, "1");

      // The discard control shows the moment the pane goes dirty, without re-rendering the pane
      // under the cursor.
      assert.equal(
        evaluate(
          "JSON.stringify([...document.querySelectorAll('.editor-pane .editor-ghost')].some((button) => button.textContent === 'Discard changes' && !button.hidden))",
        ),
        true,
      );

      // Nothing has been written yet: the draft lives in the page until the user saves.
      assert.equal(await readFile(path.join(artifactDir, "styles.css"), "utf8"), "h1 { color: rebeccapurple }\n");

      const preview = evaluate(
        "JSON.stringify({ srcdoc: document.getElementById('previewFrame').getAttribute('srcdoc') || '', sandbox: document.getElementById('previewFrame').getAttribute('sandbox') })",
      );
      assert.match(preview.srcdoc, /<style data-lavish-editor-draft="styles\.css">h1 \{ color: teal \}/);
      assert.match(preview.srcdoc, /<\\\/style>/);
      assert.equal(preview.srcdoc.includes("/sdk.js"), false);
      // No allow-same-origin: the preview is opaque-origin artifact content.
      assert.equal(preview.sandbox.includes("allow-same-origin"), false);

      // An unsaved draft survives a full page reload, because it is the user's own writing.
      run("chrome-devtools-axi", ["open", editorUrl], chromeEnv);
      wait(1200);
      const restored = evaluate(
        "(() => { const tab = [...document.querySelectorAll('.editor-tab')].find((candidate) => candidate.textContent.startsWith('styles.css')); tab.click(); return JSON.stringify({ draft: document.querySelector('.editor-code').value, save: document.getElementById('editorSave').textContent }); })()",
      );
      assert.equal(restored.draft, "h1 { color: teal } /* </style> */");
      assert.equal(restored.save, "Save 1 file");

      // The diff tab renders through the sandboxed frame. With nothing dirty it reports zero files
      // without needing the network at all; with a dirty pane it either renders or says why not.
      evaluate(
        "(() => { window.__diffEvents = []; window.addEventListener('message', (event) => { if (event.data && typeof event.data.type === 'string' && event.data.type.startsWith('lavish:diff')) window.__diffEvents.push(event.data); }); [...document.querySelectorAll('.editor-tab')].at(-1).click(); return 'ok'; })()",
      );
      // The renderer is fetched on demand, so give the network a real budget before deciding.
      let diffEvents = [];
      let outcome;
      for (let attempt = 0; attempt < 15 && !outcome; attempt += 1) {
        wait(2000);
        diffEvents = evaluate("JSON.stringify(window.__diffEvents)");
        outcome = diffEvents.find(
          (event) => event.type === "lavish:diffRendered" || event.type === "lavish:diffFailed",
        );
      }
      assert.ok(
        diffEvents.some((event) => event.type === "lavish:diffFrameReady"),
        JSON.stringify(diffEvents),
      );
      assert.ok(outcome, JSON.stringify(diffEvents));
      if (outcome.type === "lavish:diffRendered") assert.equal(outcome.files, 1);

      const diffControls = evaluate(
        "JSON.stringify({ sandbox: document.getElementById('diffFrame').getAttribute('sandbox'), src: document.getElementById('diffFrame').getAttribute('src'), options: [...document.querySelectorAll('.editor-choice-option')].map((option) => option.textContent + ':' + option.getAttribute('aria-pressed')) })",
      );
      assert.equal(diffControls.sandbox, "allow-scripts");
      assert.equal(diffControls.src, "/editor-diff-frame");
      assert.deepEqual(diffControls.options, ["Split:true", "Unified:false", "Dark:true", "Light:false"]);

      // The preview steps aside so code can have the full width, and the choice is remembered.
      const widened = evaluate(
        "(() => { document.getElementById('previewToggle').click(); return JSON.stringify({ hidden: document.body.classList.contains('preview-hidden'), label: document.getElementById('previewToggle').textContent, columns: getComputedStyle(document.getElementById('editorLayout')).gridTemplateColumns.split(' ').length, stored: localStorage.getItem('lavish-axi:editor-preview-hidden') }); })()",
      );
      assert.deepEqual(widened, { hidden: true, label: "Show preview", columns: 1, stored: "1" });
      const widenedBack = evaluate(
        "(() => { document.getElementById('previewToggle').click(); return JSON.stringify({ hidden: document.body.classList.contains('preview-hidden'), label: document.getElementById('previewToggle').textContent, columns: getComputedStyle(document.getElementById('editorLayout')).gridTemplateColumns.split(' ').length }); })()",
      );
      assert.deepEqual(widenedBack, { hidden: false, label: "Hide preview", columns: 2 });

      // Unified layout and the light theme are remembered for the next render.
      const switched = evaluate(
        "(() => { const options = [...document.querySelectorAll('.editor-choice-option')]; options.find((option) => option.textContent === 'Unified').click(); options.find((option) => option.textContent === 'Light').click(); return JSON.stringify({ style: localStorage.getItem('lavish-axi:editor-diff-style'), theme: localStorage.getItem('lavish-axi:editor-diff-theme') }); })()",
      );
      assert.deepEqual(switched, { style: "unified", theme: "light" });

      // Narrow layout stacks the preview under the sources instead of splitting side by side.
      run("chrome-devtools-axi", ["emulate", "--viewport", "420x900x1,mobile,touch"], chromeEnv);
      wait(1200);
      const narrow = evaluate(
        "JSON.stringify({ columns: getComputedStyle(document.getElementById('editorLayout')).gridTemplateColumns.split(' ').length, tabs: document.querySelectorAll('.editor-tab').length })",
      );
      assert.equal(narrow.columns, 1);
      assert.equal(narrow.tabs, 4);
      run("chrome-devtools-axi", ["emulate", "--viewport", "1440x1000x1"], chromeEnv);
      wait(1200);

      // Cmd/Ctrl+S is the keyboard form of the same explicit save.
      evaluate(
        "(() => { const tab = [...document.querySelectorAll('.editor-tab')].find((candidate) => candidate.textContent.startsWith('styles.css')); tab.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); return 'ok'; })()",
      );
      wait(1500);
      assert.equal(await readFile(path.join(artifactDir, "styles.css"), "utf8"), "h1 { color: teal } /* </style> */");
      const afterSave = evaluate(
        "JSON.stringify({ status: document.getElementById('editorStatus').textContent, save: document.getElementById('editorSave').textContent, disabled: document.getElementById('editorSave').disabled, dirtyDots: document.querySelectorAll('.editor-tab-dirty').length })",
      );
      assert.equal(afterSave.status, "Saved 1 file");
      assert.equal(afterSave.save, "Save to disk");
      assert.equal(afterSave.disabled, true);
      assert.equal(afterSave.dirtyDots, 0);

      // Writing a file queues nothing for the agent. Typing a message does not either.
      evaluate(
        "(() => { const note = document.getElementById('editorNote'); note.value = 'I retuned the heading colour'; note.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()",
      );
      const quiet = run(
        process.execPath,
        ["bin/lavish-axi.js", "poll", artifact, "--timeout-ms", "1200"],
        lavishEnv,
        60_000,
      );
      assert.equal(/"status":\s*"feedback"/.test(quiet), false, quiet);

      // Only pressing Send reaches the agent.
      evaluate("(() => { document.getElementById('editorNoteSend').click(); return 'ok'; })()");
      wait(1200);
      const delivered = run(
        process.execPath,
        ["bin/lavish-axi.js", "poll", artifact, "--timeout-ms", "4000"],
        lavishEnv,
        60_000,
      );
      assert.match(delivered, /I retuned the heading colour/);
    } finally {
      try {
        run("chrome-devtools-axi", ["stop"], chromeEnv);
      } catch {
        // The browser session may already be gone; cleanup below is what matters.
      }
      try {
        run(process.execPath, ["bin/lavish-axi.js", "stop"], lavishEnv);
      } catch {
        // Only this test's own isolated server on its own port and state directory.
      }
      await rm(temp, { recursive: true, force: true });
    }
  },
);
