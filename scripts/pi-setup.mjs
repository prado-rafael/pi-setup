#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_FILES = ['settings.json', 'mcp.json', 'models.json', 'keybindings.json'];
const TEXT_FILES = ['AGENTS.md', 'APPEND_SYSTEM.md'];
const RESOURCE_DIRS = ['extensions', 'skills', 'prompts', 'themes'];
const PRIVATE_NAMES = new Set(['auth.json', 'mcp-auth.json', 'models-store.json', 'trust.json', '.env']);
const log = message => console.error(`[pi-setup] ${message}`);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const readJSON = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Objects merge, arrays replace, and null removes a key.
export function merge(base, override) {
  if (!object(override)) return override;
  const result = { ...(object(base) ? base : {}) };
  for (const [key, value] of Object.entries(override)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Key not allowed: ${key}`);
    if (value === null) delete result[key];
    else result[key] = object(value) ? merge(result[key], value) : value;
  }
  return result;
}

export function allowed(relative) {
  if (typeof relative !== 'string') return false;
  const parts = relative.split('/');
  return !path.isAbsolute(relative) &&
    !parts.some(p => !p || p === '.' || p === '..' || p.includes('\\') || PRIVATE_NAMES.has(p) || p.startsWith('.env.')) &&
    (JSON_FILES.includes(relative) || TEXT_FILES.includes(relative) ||
      (RESOURCE_DIRS.includes(parts[0]) && parts.length > 1));
}

export function checkSecrets(relative, content) {
  if (/(?:gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|sk-[\w-]{20,}|-----BEGIN [\w ]*PRIVATE KEY-----)/.test(content)) {
    throw new Error(`Possible secret in ${relative}; use an environment variable.`);
  }
  if (!relative.endsWith('.json')) return;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /(?:api.?key|token|password|secret|authorization)/i.test(key) &&
          item && !/\$\{[A-Z_][A-Z_0-9]*\}|^\$[A-Z_][A-Z_0-9]*$|^!/.test(item)) {
        throw new Error(`Literal credential in ${relative} (${key}); use an environment variable reference.`);
      }
      visit(item);
    }
  };
  visit(JSON.parse(content));
}

export class Setup {
  constructor({ root = ROOT, env = process.env } = {}) {
    this.root = path.resolve(root);
    this.env = { ...env };
    this.home = env.HOME || os.homedir();
    this.agent = path.resolve(env.PI_CODING_AGENT_DIR || path.join(this.home, '.pi/agent'));
    this.homeDir = path.resolve(env.PI_SETUP_HOME || path.join(this.home, '.local/share/pi-setup'));
    this.bin = path.resolve(env.PI_SETUP_BIN_DIR || path.join(this.home, '.local/bin'));
    this.state = path.join(this.agent, '.pi-setup');
    this.backupId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
    this.env.PI_CODING_AGENT_DIR = this.agent;
  }

  exec(command, args, { cwd = this.root, timeout = 120000, inherit = false } = {}) {
    const result = spawnSync(command, args, {
      cwd, env: this.env, encoding: 'utf8', timeout, killSignal: 'SIGKILL',
      stdio: inherit ? ['inherit', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
      throw new Error(`${path.basename(command)} ${args.join(' ')} failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
    }
    return result.stdout?.trim() || '';
  }

  atomic(file, content, mode = 0o600) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, content, { mode, flag: 'wx' });
      fs.renameSync(temp, file); // Replace symlinks instead of writing through them.
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  backup(file, relative) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Expected a file: ${file}`);
    const target = path.join(this.state, 'backups', this.backupId, relative);
    if (stat.isSymbolicLink()) this.atomic(`${target}.symlink.json`, json({ target: fs.readlinkSync(file) }));
    else this.atomic(target, fs.readFileSync(file));
  }

  destination(relative) {
    if (!allowed(relative)) throw new Error(`Path not allowed: ${relative}`);
    let parent = this.agent;
    for (const segment of relative.split('/').slice(0, -1)) {
      parent = path.join(parent, segment);
      const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Unsafe directory: ${parent}`);
    }
    return path.join(this.agent, relative);
  }

  files() {
    const config = path.join(this.root, 'config');
    const files = new Map();
    this.fileModes = new Map();
    const walk = (directory, prefix = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isSymbolicLink()) throw new Error(`Symlink not allowed in configuration: ${relative}`);
        if (entry.isDirectory() && RESOURCE_DIRS.includes(relative.split('/')[0])) walk(path.join(directory, entry.name), `${relative}/`);
        else if (entry.isFile() && allowed(relative)) {
          let content = fs.readFileSync(path.join(directory, entry.name));
          checkSecrets(relative, content.toString('utf8'));
          if (JSON_FILES.includes(relative)) {
            const base = JSON.parse(content);
            if (!object(base)) throw new Error(`Expected a JSON object in ${relative}`);
            const override = readJSON(path.join(this.state, 'overrides', relative), {});
            if (!object(override)) throw new Error(`Invalid override: ${relative}`);
            const value = merge(base, override);
            if (relative === 'settings.json') {
              const previous = readJSON(path.join(this.agent, relative), {});
              if (previous.lastChangelogVersion) value.lastChangelogVersion = previous.lastChangelogVersion;
            }
            content = json(value);
          }
          files.set(relative, content);
          this.fileModes.set(relative, fs.statSync(path.join(directory, entry.name)).mode & 0o111 ? 0o700 : 0o600);
        } else throw new Error(`Unmanaged file/directory in config/: ${relative}`);
      }
    };
    walk(config);
    return files;
  }

  apply() {
    const files = this.files(); // Validate all inputs before changing anything.
    const previous = readJSON(path.join(this.state, 'managed.json'), []);
    if (!Array.isArray(previous)) throw new Error('Invalid managed file manifest.');
    for (const relative of new Set([...previous, ...files.keys()])) this.destination(relative);
    let changes = 0;
    for (const [relative, content] of files) {
      const target = this.destination(relative);
      const mode = this.fileModes.get(relative);
      if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink() &&
          (fs.statSync(target).mode & 0o777) === mode && fs.readFileSync(target).equals(Buffer.from(content))) continue;
      this.backup(target, relative);
      this.atomic(target, content, mode);
      changes++;
    }
    for (const relative of previous) {
      if (files.has(relative)) continue;
      const target = this.destination(relative);
      if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        this.backup(target, relative);
        fs.unlinkSync(target);
        changes++;
      }
    }
    this.atomic(path.join(this.state, 'managed.json'), json([...files.keys()]));
    if (changes) log(`Applied ${changes} file(s). Backups, when needed: ${path.join(this.state, 'backups', this.backupId)}`);
    return changes;
  }

  version() {
    const version = readJSON(path.join(this.root, 'versions.json'), {}).pi;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('versions.json must pin an exact pi version.');
    return version;
  }

  runtime(version = this.version()) {
    return path.join(this.homeDir, 'runtimes', `pi-${version}`, 'node_modules/.bin/pi');
  }

  installRuntime() {
    const version = this.version();
    if (fs.existsSync(this.runtime(version))) return;
    const runtimes = path.join(this.homeDir, 'runtimes');
    fs.mkdirSync(runtimes, { recursive: true });
    const staging = fs.mkdtempSync(path.join(runtimes, '.install-'));
    try {
      log(`Installing pi ${version} without sudo or npm lifecycle scripts...`);
      this.exec('npm', ['install', '--prefix', staging, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', `@earendil-works/pi-coding-agent@${version}`], { cwd: staging, timeout: 600000, inherit: true });
      const candidate = path.join(staging, 'node_modules/.bin/pi');
      if (!fs.existsSync(candidate)) throw new Error('npm did not create the pi executable.');
      fs.renameSync(staging, path.dirname(path.dirname(path.dirname(this.runtime(version)))));
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }

  installCommands() {
    // pi is a direct symlink to the runtime: no wrapper or setup work at startup.
    const pi = path.join(this.bin, 'pi');
    const stat = fs.lstatSync(pi, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink() || fs.readlinkSync(pi) !== this.runtime()) {
      this.backup(pi, 'bin/pi');
      fs.mkdirSync(this.bin, { recursive: true });
      const temp = `${pi}.${randomUUID()}.tmp`;
      fs.symlinkSync(this.runtime(), temp);
      fs.renameSync(temp, pi);
    }
    const manager = path.join(this.root, 'scripts/pi-setup.mjs');
    const command = `#!/usr/bin/env bash\nset -euo pipefail\nexport PI_SETUP_HOME=${quote(this.homeDir)}\nexport PI_SETUP_BIN_DIR=${quote(this.bin)}\nexec ${quote(process.execPath)} ${quote(manager)} "$@"\n`;
    const target = path.join(this.bin, 'pi-setup');
    if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink() || fs.readFileSync(target, 'utf8') !== command) {
      this.backup(target, 'bin/pi-setup');
      this.atomic(target, command, 0o755);
    }
  }

  install() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node.js >=22.19 is required.');
    this.files();
    this.installRuntime();
    this.apply();
    log('Reconciling pinned packages...');
    fs.mkdirSync(this.homeDir, { recursive: true });
    const old = this.env.npm_config_ignore_scripts;
    this.env.npm_config_ignore_scripts = 'true';
    try { this.exec(this.runtime(), ['update', '--extensions', '--no-approve'], { cwd: this.homeDir, timeout: 600000, inherit: true }); }
    finally {
      if (old === undefined) delete this.env.npm_config_ignore_scripts;
      else this.env.npm_config_ignore_scripts = old;
    }
    this.installCommands();
    log(`Ready. Put ${this.bin} first in PATH. Sign in with /login and /mcp.`);
  }

  update() {
    this.exec('git', ['pull', '--ff-only', '--no-rebase'], { inherit: true });
    // Run the updated installer rather than code loaded before the pull.
    this.exec(process.execPath, [path.join(this.root, 'scripts/pi-setup.mjs'), 'install'], { timeout: 600000, inherit: true });
  }
}

export function main(command = 'help') {
  const setup = new Setup();
  switch (command) {
    case 'install': return setup.install();
    case 'apply': return setup.apply();
    case 'update': return setup.update();
    case 'check': setup.files(); setup.version(); log('Configuration is valid; manual secret review is still required.'); return;
    case 'help': console.log('pi-setup install  Install the pinned runtime, packages, and configuration\npi-setup apply    Apply local configuration without network access\npi-setup update   Pull repository changes and run the installer\npi-setup check    Validate JSON, paths, and common secret patterns'); return;
    default: throw new Error(`Unknown command: ${command}`);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length > 3) throw new Error('Extra arguments are not supported. Use pi-setup help.');
    main(process.argv[2]);
  } catch (error) { log(error.message); process.exitCode = 1; }
}
