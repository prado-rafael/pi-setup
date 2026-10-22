# Input attention

This personal extension makes required agent questions hard to miss without
changing the terminal palette, saved theme, editor, or existing footer.

## Behavior

- Agent questions cover the visible Pi viewport with a yellow background and
  dark text, including the answer field. The conversation is temporarily hidden.
- Answer with Enter or cancel with Escape. The previous screen returns unchanged.
- Use Page Up/Page Down to read long questions. Typing returns the view to the
  answer field.
- While a dialog is open, the tab title begins with `Aguardando você`.
- Other extensions' native dialogs keep their own UI and show the existing
  warning-colored indicator above the editor.
- Final completion shows `Concluído` in green. Cancellation or unanswered input
  shows `Interrompido`, without implying approval. Unrecovered model errors show
  `Erro` in red.

The visible labels are Portuguese to match the personal setup.

## Agent questions

The `request_user_input` tool waits for an answer and returns it to the agent.
Its instructions require it only when an answer, permission, clarification, or
decision is necessary to continue. It must not be used for optional follow-up
offers after a completed task. Cancellation and empty answers instruct the agent
to stop instead of asking again or assuming approval.

Questions written only as ordinary assistant text do not trigger the yellow
screen. The agent must use `request_user_input`.

Native `ui_prompt_start` and `ui_prompt_end` events control the indicator and tab
title. RPC clients keep the native input dialog without terminal widgets or the
yellow screen. Non-interactive runs are instructed to ask in their final response
and wait.

## Try it

After applying the setup, run `/reload` in an existing Pi session. New sessions
load the extension automatically. Run `/input-alert-test` to try the yellow
screen without calling a model, then answer or press Escape.

To remove the extension from managed environments, delete this directory from
the setup repository, apply the setup, and run `/reload`.

## Validation

The behavioral tests are in `test/input-attention.test.mjs`. They use Pi's real
extension loader, runner, and input component, including answer/cancel/abort,
viewport sizing, themes, wide characters, long questions, RPC, and print mode.
See the repository README for the pinned test runtime setup.
