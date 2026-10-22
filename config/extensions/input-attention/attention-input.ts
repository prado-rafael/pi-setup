import { ExtensionInputComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, rgbColor, styleText, visibleWidth } from "@earendil-works/pi-tui";

const foreground = rgbColor(17, 17, 17);
const background = rgbColor(255, 215, 0);

export async function attentionInput(ctx: ExtensionContext, question: string, signal?: AbortSignal) {
  if (signal?.aborted) return undefined;
  if (ctx.mode !== "tui") return ctx.ui.input(question, "Digite sua resposta...", { signal });

  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const input = new ExtensionInputComponent(
      `AGUARDANDO SUA RESPOSTA\n\n${question}`,
      undefined,
      done,
      () => done(undefined),
      { description: "PgUp/PgDn: rolar pergunta" },
    );
    let scroll = 0;
    const abort = () => done(undefined);
    signal?.addEventListener("abort", abort, { once: true });
    // Cancellation can happen while Pi is creating the custom screen.
    if (signal?.aborted) queueMicrotask(abort);

    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      handleInput(data: string) {
        const page = Math.max(1, tui.terminal.rows - 2);
        if (matchesKey(data, "pageUp")) scroll += page;
        else if (matchesKey(data, "pageDown")) scroll = Math.max(0, scroll - page);
        else {
          scroll = 0;
          input.handleInput(data);
        }
      },
      invalidate() { input.invalidate(); },
      dispose() {
        signal?.removeEventListener("abort", abort);
        input.dispose();
      },
      render(width: number) {
        const height = Math.max(1, tui.terminal.rows);
        const content = input.render(width);
        // Start at the input in short terminals; the question remains scrollable.
        scroll = Math.min(scroll, Math.max(0, content.length - height));
        const start = Math.max(0, content.length - height - scroll);
        const visible = content.slice(start, start + height);
        const top = Math.max(0, Math.floor((height - visible.length) / 2));
        return Array.from({ length: height }, (_, row) => {
          const line = (visible[row - top] ?? "").replace(/\x1b\[[0-9;:]*m/g, "");
          return styleText(line + " ".repeat(Math.max(0, width - visibleWidth(line))), {
            fg: foreground, bg: background,
          }, theme.getColorMode());
        });
      },
    };
  }, {
    overlay: true,
    overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
  });
}
