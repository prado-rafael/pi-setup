import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const version = JSON.parse(readFileSync(new URL("../versions.json", import.meta.url), "utf8")).pi;
const install = resolve(process.env.PI_TEST_RUNTIME ?? join(
  process.env.PI_SETUP_HOME ?? join(homedir(), ".local/share/pi-setup"), "runtimes", `pi-${version}`,
));
const dist = join(install, "node_modules/@earendil-works/pi-coding-agent/dist");
const { loadExtensions } = await import(pathToFileURL(join(dist, "core/extensions/loader.js")));
const { ExtensionRunner } = await import(pathToFileURL(join(dist, "core/extensions/runner.js")));
const { initTheme, getThemeByName } = await import(pathToFileURL(join(dist, "modes/interactive/theme/theme.js")));
const { CURSOR_MARKER, visibleWidth } = await import(pathToFileURL(join(dist, "../../pi-tui/dist/index.js")));
const extensionPath = fileURLToPath(new URL("../config/extensions/input-attention", import.meta.url));
const stripStyles = (line) => line.replace(/\x1b\[[0-9;:]*m/g, "");
initTheme("dark", false);

async function setup(mode = "tui", themeName = "dark") {
  const loaded = await loadExtensions([extensionPath], "/tmp/input-alert-test");
  assert.deepEqual(loaded.errors, []);
  let sessionName;
  loaded.runtime.getSessionName = () => sessionName;
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, "/tmp/input-alert-test", {}, {});
  const errors = [];
  runner.onError((error) => errors.push(error));
  const widgets = new Map();
  const colors = [];
  const theme = getThemeByName(themeName);
  const tui = { terminal: { rows: 30 }, requestRender() {} };
  let title;
  let finish;
  let inputOptions;
  let customOptions;
  let component;
  let customCalls = 0;
  const ui = {
    theme: { fg(color, text) { colors.push(color); return text; } },
    setTitle(value) { title = value; },
    setWidget(key, factory) {
      if (factory) widgets.set(key, factory(tui, theme));
      else widgets.delete(key);
    },
    input(_title, _placeholder, options) {
      inputOptions = options;
      return new Promise((resolve) => {
        finish = resolve;
        if (options?.signal?.aborted) resolve(undefined);
        else options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    },
    custom(factory, options) {
      customCalls++;
      customOptions = options;
      return new Promise((resolve) => {
        finish = (value) => {
          component?.dispose?.();
          component = undefined;
          resolve(value);
        };
        if (typeof factory === "function") {
          component = factory(tui, theme, {}, finish);
          component.focused = true;
        }
      });
    },
  };
  ui.select = ui.confirm = ui.editor = () => new Promise((resolve) => { finish = resolve; });
  if (mode !== "print") runner.setUIContext(ui, mode);
  const emit = async (type, fields = {}) => {
    await runner.emit({ type, ...fields });
    assert.deepEqual(errors, []);
  };
  await emit("session_start");
  return {
    runner, emit, ui, colors, tui,
    get title() { return title; },
    get inputOptions() { return inputOptions; },
    get customOptions() { return customOptions; },
    get customCalls() { return customCalls; },
    get component() { return component; },
    setName(value) { sessionName = value; },
    finish(value) { finish(value); },
    lines(width = 100) {
      return widgets.get("input-attention")?.render(width).map((line) => stripStyles(line).trimEnd()) ?? [];
    },
    screen(width = 100) { return component?.render(width) ?? []; },
    key(data) { component.handleInput(data); },
    async ask(question = "Qual ambiente devo usar?", signal) {
      const tool = runner.getToolDefinition("request_user_input");
      return tool.execute("test-1", { question }, signal, undefined, runner.createToolContext("test-1", signal));
    },
  };
}

async function flush() { await setImmediate(); }

function assertYellowScreen(h, width, height) {
  h.tui.terminal.rows = height;
  const lines = h.screen(width);
  assert.equal(lines.length, height);
  for (const line of lines) {
    assert.equal(visibleWidth(line), width);
    assert.match(line, /\x1b\[(?:48;2;255;215;0|48;5;220)m/);
    assert.match(line, /\x1b\[(?:38;2;17;17;17|38;5;233)m/);
  }
  return lines;
}

test("shows green only at final settlement, clearing it for the next run", async () => {
  const h = await setup();
  assert.deepEqual(h.lines(), []);
  assert.equal(h.title, "Pi - input-alert-test");
  await h.emit("agent_start");
  await h.emit("agent_end", { messages: [] });
  assert.deepEqual(h.lines(), []);
  await h.emit("agent_settled", { aborted: false });
  assert.deepEqual(h.lines(), ["Concluído"]);
  assert.equal(h.colors.at(-1), "success");
  await h.emit("agent_start");
  assert.deepEqual(h.lines(), []);
});

test("all native blocking dialogs retain their indicator and restore the title", async () => {
  const h = await setup();
  for (const kind of ["input", "confirm", "select", "editor", "custom"]) {
    const pending = h.runner.getUIContext()[kind]("Preciso de você", []);
    await flush();
    assert.deepEqual(h.lines(), ["Aguardando sua resposta"]);
    assert.equal(h.colors.at(-1), "warning");
    assert.equal(h.title, "Aguardando você | Pi - input-alert-test");
    h.finish("ok");
    await pending;
    await flush();
    assert.deepEqual(h.lines(), []);
    assert.equal(h.title, "Pi - input-alert-test");
  }
});

test("explicit input waits on the yellow screen and returns the typed answer unchanged", async () => {
  const h = await setup();
  await h.emit("agent_start");
  const controller = new AbortController();
  let completed = false;
  const pending = h.ask("Qual ambiente devo usar?", controller.signal).then((value) => { completed = true; return value; });
  await flush();
  assert.equal(completed, false);
  assert.deepEqual(h.lines(), ["Aguardando sua resposta"]);
  assert.deepEqual(h.customOptions, {
    overlay: true,
    overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
  });
  const screen = assertYellowScreen(h, 100, 30).map(stripStyles).join("\n");
  assert.match(screen, /AGUARDANDO SUA RESPOSTA/);
  assert.match(screen, /Qual ambiente devo usar\?/);
  assert.ok(screen.includes(CURSOR_MARKER));
  h.key("Use homologação, não produção.");
  h.key("\r");
  assert.deepEqual(await pending, {
    content: [{ type: "text", text: "Use homologação, não produção." }],
    details: { question: "Qual ambiente devo usar?", answer: "Use homologação, não produção." },
  });
  await flush();
  assert.deepEqual(h.screen(), []);
  assert.deepEqual(h.lines(), []);
  await h.emit("agent_settled", { aborted: false });
  assert.deepEqual(h.lines(), ["Concluído"]);
});

test("cancelled or empty input is not represented as completion or approval", async () => {
  for (const answer of [undefined, "", "   "]) {
    const h = await setup();
    await h.emit("agent_start");
    const pending = h.ask();
    await flush();
    if (answer === undefined) h.key("\x1b");
    else { h.key(answer); h.key("\r"); }
    const result = await pending;
    assert.equal(result.details.answer, null);
    assert.match(result.content[0].text, /Do not ask again automatically or assume approval/);
    await flush();
    assert.deepEqual(h.screen(), []);
    await h.emit("agent_settled", { aborted: false });
    assert.deepEqual(h.lines(), ["Interrompido"]);
    await h.emit("agent_start");
    await h.emit("agent_settled", { aborted: false });
    assert.deepEqual(h.lines(), ["Concluído"]);
  }
});

test("abort closes the screen without a green completion", async () => {
  const h = await setup();
  await h.emit("agent_start");
  const controller = new AbortController();
  const pending = h.ask("Continuar?", controller.signal);
  await flush();
  controller.abort();
  await pending;
  await flush();
  await h.emit("agent_settled", { aborted: true });
  assert.deepEqual(h.screen(), []);
  assert.deepEqual(h.lines(), ["Interrompido"]);
  assert.equal(h.title, "Pi - input-alert-test");
});

test("an already aborted request never opens a screen", async () => {
  const h = await setup();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await h.ask("Continuar?", controller.signal)).details.answer, null);
  assert.equal(h.customCalls, 0);
});

test("full yellow rendering survives resizing, narrow widths, themes, and wide characters", async () => {
  for (const theme of ["dark", "light"]) {
    const h = await setup("tui", theme);
    const pending = h.ask("Posso continuar? Ação 日本語");
    await flush();
    for (const [width, height] of [[100, 30], [40, 18], [8, 8], [1, 1], [120, 40]]) {
      h.component.invalidate();
      assertYellowScreen(h, width, height);
    }
    h.key("\x1b");
    await pending;
  }
});

test("long questions can be paged without losing the answer field", async () => {
  const h = await setup();
  h.tui.terminal.rows = 10;
  const question = Array.from({ length: 30 }, (_, i) => `Linha ${i + 1}`).join("\n");
  const pending = h.ask(question);
  await flush();
  assert.ok(h.screen(60).join("").includes(CURSOR_MARKER));
  for (let i = 0; i < 10; i++) { h.key("\x1b[5~"); h.screen(60); }
  assert.match(h.screen(60).map(stripStyles).join("\n"), /Linha 1/);
  h.key("\x1b[6~");
  h.key("sim");
  assert.ok(h.screen(60).join("").includes(CURSOR_MARKER));
  h.key("\r");
  assert.equal((await pending).details.answer, "sim");
});

test("provider errors are red, but a successful retry is not left in error", async () => {
  const h = await setup();
  await h.emit("agent_start");
  await h.runner.emitMessageEnd({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
  await h.emit("agent_settled", { aborted: false });
  assert.deepEqual(h.lines(), ["Erro"]);
  assert.equal(h.colors.at(-1), "error");
  await h.runner.emitMessageEnd({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  await h.emit("agent_settled", { aborted: false });
  assert.deepEqual(h.lines(), ["Concluído"]);
});

test("test command exercises the same yellow screen without sending a model message", async () => {
  const h = await setup();
  const pending = h.runner.getCommand("input-alert-test").handler("", h.runner.createCommandContext());
  await flush();
  assert.deepEqual(h.lines(), ["Aguardando sua resposta"]);
  assertYellowScreen(h, 80, 24);
  h.key("\x1b");
  await pending;
  await flush();
  assert.deepEqual(h.screen(), []);
  assert.deepEqual(h.lines(), []);
});

test("session names, widget theme changes and cleanup are supported", async () => {
  const h = await setup();
  h.setName("Minha sessão");
  await h.emit("session_info_changed", { name: "Minha sessão" });
  assert.equal(h.title, "Pi - Minha sessão - input-alert-test");
  const pending = h.runner.getUIContext().input("Pergunta");
  await flush();
  assert.ok(h.lines(8).every((line) => line.length <= 8));
  h.ui.theme.fg = (color, text) => `${color}: ${text}`;
  assert.deepEqual(h.lines(), ["warning: Aguardando sua resposta"]);
  h.finish(undefined);
  await pending;
  await flush();
  await h.emit("agent_settled", { aborted: false });
  await h.emit("session_tree");
  assert.deepEqual(h.lines(), []);
  await h.emit("agent_settled", { aborted: false });
  await h.emit("session_shutdown", { reason: "reload" });
  assert.deepEqual(h.lines(), []);
  assert.equal(h.title, "Pi - Minha sessão - input-alert-test");
});

test("print mode does not use terminal UI and asks for a normal final question", async () => {
  const h = await setup("print");
  const result = await h.ask("Qual ambiente?");
  assert.deepEqual(result.details, { question: "Qual ambiente?", answer: null });
  assert.equal(result.content[0].text, "Interactive input is unavailable. Ask the user this question in your final response and wait: Qual ambiente?");
  await h.emit("agent_start");
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.title, undefined);
  assert.deepEqual(h.lines(), []);
  assert.equal(h.customCalls, 0);
});

test("RPC keeps the native input dialog and its abort signal without a terminal screen", async () => {
  const h = await setup("rpc");
  const controller = new AbortController();
  const pending = h.ask(undefined, controller.signal);
  await flush();
  assert.equal(h.title, undefined);
  assert.deepEqual(h.lines(), []);
  assert.equal(h.inputOptions.signal, controller.signal);
  assert.equal(h.customCalls, 0);
  h.finish("homologação");
  assert.equal((await pending).details.answer, "homologação");
});
