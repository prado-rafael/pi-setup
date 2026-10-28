# My pi setup

A single source of truth for my personal [pi](https://pi.dev) configuration on Linux, containers, and macOS.

**Everything is manual.** Starting `pi` runs the installed executable directly. This setup does not check Git, copy configuration, or run an updater when you open pi. There are no timers, background jobs, or startup hooks.

> Public repository: [prado-rafael/pi-setup](https://github.com/prado-rafael/pi-setup).

## Install

Prerequisites: Bash, Git, Node.js >=22.19, npm, and access to the repository and npm registry. The installer does not require sudo or modify system packages.

```bash
git clone https://github.com/prado-rafael/pi-setup.git "$HOME/.local/share/pi-setup/repo"
cd "$HOME/.local/share/pi-setup/repo"
./install.sh

export PATH="$HOME/.local/bin:$PATH"
hash -r
pi
```

Add the PATH line to your shell startup file or container environment. The installer does not edit shell files. Cloning this public repository does not require GitHub authentication. To push changes, authenticate Git with `gh auth login` and `gh auth setup-git`, or use an authenticated SSH clone.

In pi, run `/login` and select `github-copilot`. Use `/mcp` to sign in to Atlassian and Datadog if required. Credentials stay in that environment, not in Git.

For containers, use an image with a compatible Node version, such as `node:22-bookworm-slim`, and install Bash, Git, and CA certificates in the image. Use a private volume for `~/.pi/agent` if you want credentials and sessions to survive container recreation. Never bake tokens into an image.

## Update only when needed

In any environment you want to update:

```bash
pi-setup update
```

This runs `git pull --ff-only --no-rebase` in the setup repository and reruns the installer. It fetches the configuration, installs the pinned pi version if necessary, and reconciles packages. Git errors stop the update; local history is never reset.

The equivalent without the shortcut is:

```bash
cd "$HOME/.local/share/pi-setup/repo"
git pull --ff-only --no-rebase
./install.sh
```

**Other containers do not change until you explicitly update them.** If pi is already running, use `/reload` after configuration changes or restart it after a runtime upgrade.

## Change the shared configuration

Edit the files in this repository, test, and push:

```bash
cd "$HOME/.local/share/pi-setup/repo"
# Edit config/settings.json, config/mcp.json, or another managed file.
npm run check
npm test
pi-setup apply

git add config versions.json
git commit -m "Adjust pi configuration"
git push
```

`pi-setup apply` copies the current checkout's configuration without fetching from Git or installing packages. Use `./install.sh` instead if you changed package declarations or `versions.json`.

## Files

| Path | Purpose |
|---|---|
| `config/settings.json` | Model, thinking, compaction, tools, and packages |
| `config/models.json` | Context window overrides |
| `config/mcp.json` | Atlassian and Datadog MCP servers |
| `config/extensions/ccstatusline.ts` | Custom status footer |
| `config/extensions/input-attention/` | Full yellow-screen agent questions and waiting/completion indicators |
| `versions.json` | Exact pi version to install |

You can also add `config/keybindings.json`, `config/AGENTS.md`, `config/APPEND_SYSTEM.md`, and resources under `config/extensions/`, `config/skills/`, `config/prompts/`, or `config/themes/`.

The existing model IDs, context overrides, Datadog EU endpoint, and tool exposure rules are preserved. Model availability and limits depend on your provider. Hidden-tool rules are not a substitute for server-side permissions.

Pi is pinned to `1.1.0`, and `pi-memory` to `0.4.2`. Change the versions here and explicitly run the installer/update command wherever you want the new versions. The runtime uses a private npm prefix and disables lifecycle scripts; global npm packages are not modified. Transitive dependencies are not locked, so this is not a hermetic build.

The `pi-memory` extension works without extra dependencies for basic memory operations. Its search feature additionally requires qmd (`npm install -g @tobilu/qmd`), which is optional and may download large embedding models. Memory contents are not synchronized by this setup.

The setup also installs `pi-btw` (`pi install npm:pi-btw`) for `/btw` side conversations. It is not version-pinned and is reconciled when you explicitly run the installer/update command.

The setup installs `@juicesharp/rpiv-todo` (`pi install npm:@juicesharp/rpiv-todo`) for a persistent task-list panel and the `/todos` command. It is not version-pinned and is reconciled on explicit installs/updates. Restart Pi after installation, then run `/todos` to confirm it loaded. Press `ctrl+shift+t` to collapse or expand the panel.

## Required-input alert

The bundled [input-attention extension](config/extensions/input-attention/README.md)
adds `request_user_input` for questions that block the agent. Those questions fill
the visible Pi viewport with a yellow background and dark text. Enter submits the
answer; Escape cancels and restores the conversation. Page Up/Page Down scroll
long questions. The extension does not change the terminal palette or saved theme.

Apply the setup and run `/reload`, then `/input-alert-test` to try it without a
model call. Other extensions' native dialogs retain their UI and show the waiting
indicator. Ordinary text questions do not trigger the yellow screen; the agent
must use the tool. Labels are Portuguese to match this personal configuration.

## Local exceptions

Optional: put environment-specific JSON overrides in `~/.pi/agent/.pi-setup/overrides/`, using the corresponding configuration filename. For example, `overrides/settings.json`:

```json
{
  "defaultThinkingLevel": "medium"
}
```

Then run `pi-setup apply`. Objects merge, arrays replace, and `null` removes a key. These overrides stay outside the repository.

Changes made directly to `~/.pi/agent` through `/settings`, `/mcp`, or similar commands remain untouched until the next manual application. To keep them across future applications, put the equivalent change in the repository or a local override. Pi's internal `lastChangelogVersion` field is preserved.

## Backups and credentials

- Credentials, `.env` files, trust decisions, sessions, and memories are not copied into the repository or synchronized.
- Existing unmanaged destination files are left alone. Managed files that are replaced or removed are backed up under `~/.pi/agent/.pi-setup/backups/<date-id>/` with private permissions.
- Previous `pi` and `pi-setup` commands are backed up under that backup's `bin/` directory. Symlink backups use `<name>.symlink.json` to record the original target.
- Review changes for secrets before pushing. `npm run check` catches some common patterns, not every possible secret. Extensions and scripts run with your user permissions.
- Run one setup command at a time. Individual file writes are atomic, but applying the whole set is not transactional. If an operation fails midway, fix the cause and rerun it.

To restore a regular file:

```bash
cp "$HOME/.pi/agent/.pi-setup/backups/<date-id>/settings.json" "$HOME/.pi/agent/settings.json"
```

A later manual application will use the repository/overrides again. Keep any desired restoration there too. Backups are never uploaded or automatically deleted.

## Commands

```text
./install.sh       Install pi, packages, and configuration
pi-setup apply     Apply local configuration only; no network access
pi-setup update    Pull repository changes and rerun the installer
pi-setup check     Validate configuration and common secret patterns
```

Default paths are `~/.pi/agent` for pi data, `~/.local/share/pi-setup` for runtimes, and `~/.local/bin` for commands. Set `PI_CODING_AGENT_DIR`, `PI_SETUP_HOME`, or `PI_SETUP_BIN_DIR` if needed. If using a custom agent directory, export it when running pi too.

The `pi` command is a direct symlink to the installed runtime. Only the `pi-setup` shortcut depends on the checkout location; rerun `./install.sh` if you move it. To stop using this setup, remove the two commands or restore their previous versions from backups. Configuration, credentials, and sessions remain intact.

## Development

Keep repository documentation, comments, messages, and examples in English.

```bash
npm run check
npm test
bash -n install.sh
```

The extension tests use the pinned Pi runtime installed by this setup. To test a
fresh checkout without installing or changing your personal configuration, use
an isolated runtime instead:

```bash
runtime="$(mktemp -d)"
version="$(node -p "require('./versions.json').pi")"
npm install --prefix "$runtime" --ignore-scripts --omit=dev --no-audit --no-fund --no-package-lock "@earendil-works/pi-coding-agent@$version"
PI_TEST_RUNTIME="$runtime" npm test
rm -rf "$runtime"
```

Setup tests use temporary directories, local Git remotes, and simulated runtimes.
Extension tests use the real loader, runner, and input component from the pinned
runtime with a simulated terminal UI. Tests do not touch your installation or
credentials. CI installs an isolated test runtime and runs on Linux and macOS
with Node 22 and 24.
