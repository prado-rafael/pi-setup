import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { attentionInput } from "./attention-input.ts";

type State = "idle" | "working" | "done" | "stopped" | "error";
const WIDGET = "input-attention";
const inputParameters = Type.Object({
  question: Type.String({ minLength: 1, description: "The question to display, in the user's language, with enough context to answer." }),
});
type InputDetails = { question: string; answer: string | null };

export default function (pi: ExtensionAPI) {
  let state: State = "idle";
  let waiting = false;
  let failed = false;
  let unanswered = false;

  function render(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    const session = pi.getSessionName();
    const title = session
      ? `Pi - ${session} - ${basename(ctx.cwd)}`
      : `Pi - ${basename(ctx.cwd)}`;
    const label = waiting ? "Aguardando sua resposta"
      : state === "done" ? "Concluído"
      : state === "stopped" ? "Interrompido"
      : state === "error" ? "Erro"
      : undefined;
    const color = waiting ? "warning"
      : state === "done" ? "success"
      : state === "error" ? "error"
      : "muted";

    ctx.ui.setTitle(waiting ? `Aguardando você | ${title}` : title);
    if (!label) {
      ctx.ui.setWidget(WIDGET, undefined);
      return;
    }

    ctx.ui.setWidget(WIDGET, () => ({
      render(width: number) {
        return new Text(ctx.ui.theme.fg(color, label), 0, 0).render(width);
      },
      invalidate() {},
    }), { placement: "aboveEditor" });
  }

  function reset(ctx: ExtensionContext) {
    state = "idle";
    waiting = false;
    failed = false;
    unanswered = false;
    render(ctx);
  }

  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_info_changed", (_event, ctx) => render(ctx));
  pi.on("session_shutdown", (_event, ctx) => reset(ctx));

  pi.on("agent_start", (_event, ctx) => {
    state = "working";
    failed = false;
    unanswered = false;
    render(ctx);
  });

  pi.on("ui_prompt_start", (_event, ctx) => {
    waiting = true;
    render(ctx);
  });

  pi.on("ui_prompt_end", (_event, ctx) => {
    waiting = false;
    render(ctx);
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
    }
  });

  // Only final settlement is completion; agent_end can still be followed by retries.
  pi.on("agent_settled", (event, ctx) => {
    state = event.aborted || unanswered ? "stopped" : failed ? "error" : "done";
    render(ctx);
  });

  pi.registerTool<typeof inputParameters, InputDetails>({
    name: "request_user_input",
    label: "Pergunta para você",
    description: "Ask the user for information or a decision needed to proceed. Opens an input dialog and waits for their reply.",
    promptSnippet: "Ask for required user input with an explicit waiting indicator.",
    promptGuidelines: [
      "When you cannot proceed without the user's answer, clarification, permission, or decision, use request_user_input rather than only asking in your final text. Do not use it for optional follow-up offers or completed tasks. Call it alone, never alongside other tools. If cancelled or unanswered, stop without repeating the dialog or assuming approval.",
    ],
    exposure: "model-only",
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: inputParameters,
    async execute(_id, { question }, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: `Interactive input is unavailable. Ask the user this question in your final response and wait: ${question}` }],
          details: { question, answer: null },
        };
      }

      const answer = await attentionInput(ctx, question, signal);
      if (!answer?.trim()) {
        unanswered = true;
        return {
          content: [{ type: "text", text: "The user cancelled or left the answer empty. Stop and explain that the task is waiting for their input. Do not ask again automatically or assume approval." }],
          details: { question, answer: null },
        };
      }
      return {
        content: [{ type: "text", text: answer }],
        details: { question, answer },
      };
    },
    renderCall({ question }, theme) {
      return new Text(theme.fg("warning", question || "Pergunta para você"), 0, 0);
    },
    renderResult(result, _options, theme) {
      const answer = result.details?.answer;
      return new Text(answer ? theme.fg("success", `Resposta: ${answer}`) : theme.fg("muted", "Sem resposta"), 0, 0);
    },
  });

  pi.registerCommand("input-alert-test", {
    description: "Testar a tela amarela e o título de espera, sem chamar o modelo",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      await attentionInput(ctx, "Teste do aviso: digite qualquer coisa ou pressione Esc");
    },
  });
}
