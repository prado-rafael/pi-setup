import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Setup, merge, allowed, checkSecrets } from '../scripts/pi-setup.mjs';

const script = fileURLToPath(new URL('../scripts/pi-setup.mjs', import.meta.url));
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const get = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(get(file));

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-setup-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo with space's");
  const home = path.join(temp, "home with space's");
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'), PI_SETUP_HOME: path.join(home, '.local/share/pi-setup'), PI_SETUP_BIN_DIR: path.join(home, '.local/bin'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  put(path.join(root, 'scripts/pi-setup.mjs'), get(script));
  put(path.join(root, 'versions.json'), '{"pi":"1.1.0"}');
  put(path.join(root, 'config/settings.json'), '{"defaultModel":"first","packages":[]}');
  put(path.join(root, 'config/mcp.json'), '{"mcpServers":{"one":{"url":"https://example.com"}}}');
  put(path.join(root, 'config/extensions/status.ts'), 'export default function () {}\n');
  const setup = new Setup({ root, env });
  return { temp, root, home, env, setup };
}

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runtime(setup) {
  const file = setup.runtime();
  put(file, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(path.join(setup.homeDir, 'calls.jsonl'))}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),ignoreScripts:process.env.npm_config_ignore_scripts})+'\\n');\n`);
  fs.chmodSync(file, 0o755);
}

function remoteFixture(t) {
  const f = fixture(t);
  const remote = path.join(f.temp, 'remote.git');
  git(f.temp, 'init', '--bare', '--initial-branch=main', remote);
  git(f.root, 'init', '--initial-branch=main');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-m', 'initial');
  git(f.root, 'remote', 'add', 'origin', remote);
  git(f.root, 'push', '-u', 'origin', 'main');
  const writer = path.join(f.temp, 'writer');
  git(f.temp, 'clone', remote, writer);
  runtime(f.setup);
  f.setup.install();
  return { ...f, remote, writer };
}

function commitModel(directory, model) {
  put(path.join(directory, 'config/settings.json'), JSON.stringify({ defaultModel: model, packages: [] }));
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', model);
}

test('merge supports objects, arrays, deletions, and prototype protection', () => {
  assert.deepEqual(merge({ a: { x: 1, y: 2 }, list: [1, 2] }, { a: { x: null, z: 3 }, list: [4] }), { a: { y: 2, z: 3 }, list: [4] });
  assert.throws(() => merge({}, JSON.parse('{"__proto__":{"polluted":true}}')), /Key not allowed/);
  assert.equal({}.polluted, undefined);
});

test('only portable files are allowed; credentials cannot become managed files', () => {
  for (const file of ['auth.json', 'mcp-auth.json', 'models-store.json', 'sessions/a', 'memory/MEMORY.md', '../auth.json', '/tmp/settings.json', 'extensions/../../auth.json', 'extensions/..\\secret']) assert.equal(allowed(file), false, file);
  for (const file of ['settings.json', 'AGENTS.md', 'extensions/status.ts', 'skills/foo/SKILL.md']) assert.equal(allowed(file), true, file);
});

test('secret heuristics reject literals but accept environment references', () => {
  assert.throws(() => checkSecrets('models.json', '{"apiKey":"very-private"}'), /Literal credential/);
  assert.throws(() => checkSecrets('extensions/foo.ts', `const token = 'ghp_${'a'.repeat(30)}'`), /Possible secret/);
  assert.doesNotThrow(() => checkSecrets('mcp.json', '{"headers":{"Authorization":"Bearer ${TOOLS_TOKEN}"}}'));
});

test('apply backs up existing files, preserves private state, and is idempotent', t => {
  const { setup } = fixture(t);
  put(path.join(setup.agent, 'settings.json'), '{"defaultModel":"old","lastChangelogVersion":"1.0.0"}');
  const untouched = ['auth.json', 'mcp-auth.json', 'trust.json', 'models-store.json', 'memory/MEMORY.md', 'sessions/one.jsonl', 'extensions/unmanaged.ts'];
  for (const file of untouched) put(path.join(setup.agent, file), 'private or unmanaged');
  assert.equal(setup.apply(), 3);
  assert.equal(json(path.join(setup.agent, 'settings.json')).lastChangelogVersion, '1.0.0');
  assert.equal(json(path.join(setup.state, 'backups', setup.backupId, 'settings.json')).defaultModel, 'old');
  for (const file of untouched) assert.equal(get(path.join(setup.agent, file)), 'private or unmanaged');
  const before = fs.statSync(path.join(setup.agent, 'settings.json')).mtimeMs;
  assert.equal(setup.apply(), 0);
  assert.equal(fs.statSync(path.join(setup.agent, 'settings.json')).mtimeMs, before);
});

test('binary skill resources and executable permissions are preserved', t => {
  const { setup } = fixture(t);
  const bytes = Buffer.from([0, 255, 128, 42, 13, 10]);
  put(path.join(setup.root, 'config/skills/example/image.png'), bytes);
  put(path.join(setup.root, 'config/skills/example/run.sh'), '#!/usr/bin/env bash\necho ok\n');
  fs.chmodSync(path.join(setup.root, 'config/skills/example/run.sh'), 0o755);
  setup.apply();
  assert.deepEqual(fs.readFileSync(path.join(setup.agent, 'skills/example/image.png')), bytes);
  assert.equal(fs.statSync(path.join(setup.agent, 'skills/example/run.sh')).mode & 0o777, 0o700);
  assert.equal(setup.apply(), 0);
});

test('local overrides remain outside the repository and support server deletion', t => {
  const { setup } = fixture(t);
  put(path.join(setup.state, 'overrides/settings.json'), '{"defaultModel":"local"}');
  put(path.join(setup.state, 'overrides/mcp.json'), '{"mcpServers":{"one":null}}');
  setup.apply();
  assert.equal(json(path.join(setup.agent, 'settings.json')).defaultModel, 'local');
  assert.deepEqual(json(path.join(setup.agent, 'mcp.json')), { mcpServers: {} });
  assert.equal(json(path.join(setup.root, 'config/settings.json')).defaultModel, 'first');
});

test('removed managed files are backed up and deleted', t => {
  const { setup } = fixture(t);
  setup.apply();
  fs.unlinkSync(path.join(setup.root, 'config/extensions/status.ts'));
  assert.equal(setup.apply(), 1);
  assert.equal(fs.existsSync(path.join(setup.agent, 'extensions/status.ts')), false);
  assert.equal(get(path.join(setup.state, 'backups', setup.backupId, 'extensions/status.ts')), 'export default function () {}\n');
});

test('invalid JSON and forbidden files fail before changing configuration', t => {
  const { setup } = fixture(t);
  put(path.join(setup.agent, 'settings.json'), '{}');
  put(path.join(setup.root, 'config/mcp.json'), '{bad');
  assert.throws(() => setup.apply());
  assert.equal(get(path.join(setup.agent, 'settings.json')), '{}');
  put(path.join(setup.root, 'config/mcp.json'), '{}');
  put(path.join(setup.root, 'config/auth.json'), '{}');
  assert.throws(() => setup.apply(), /Unmanaged file/);
});

test('source symlinks, target directory symlinks, and manifest traversal are rejected', t => {
  const { setup, temp } = fixture(t);
  const outside = path.join(temp, 'outside');
  put(path.join(outside, 'secret'), 'private');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(setup.root, 'config/extensions/secret.ts'));
  assert.throws(() => setup.files(), /Symlink/);
  fs.unlinkSync(path.join(setup.root, 'config/extensions/secret.ts'));
  fs.mkdirSync(setup.agent, { recursive: true });
  fs.symlinkSync(outside, path.join(setup.agent, 'extensions'));
  assert.throws(() => setup.apply(), /Unsafe directory/);
  fs.unlinkSync(path.join(setup.agent, 'extensions'));
  put(path.join(setup.state, 'managed.json'), '["../secret"]');
  assert.throws(() => setup.apply(), /Path not allowed/);
  assert.equal(get(path.join(outside, 'secret')), 'private');
});

test('target file symlinks are backed up and replaced, not followed', t => {
  const { setup, temp } = fixture(t);
  const outside = path.join(temp, 'settings.json');
  put(outside, '{"defaultModel":"outside"}');
  fs.mkdirSync(setup.agent, { recursive: true });
  fs.symlinkSync(outside, path.join(setup.agent, 'settings.json'));
  setup.apply();
  assert.equal(json(outside).defaultModel, 'outside');
  assert.equal(fs.lstatSync(path.join(setup.agent, 'settings.json')).isSymbolicLink(), false);
  assert.equal(json(path.join(setup.state, 'backups', setup.backupId, 'settings.json.symlink.json')).target, outside);
});

test('pi runs directly without fetching, applying configuration, or changing arguments', t => {
  const { setup, temp, env } = fixture(t);
  runtime(setup);
  put(path.join(setup.bin, 'pi'), 'old launcher');
  setup.install();
  assert.equal(get(path.join(setup.state, 'backups', setup.backupId, 'bin/pi')), 'old launcher');
  assert.equal(fs.lstatSync(path.join(setup.bin, 'pi')).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(path.join(setup.bin, 'pi')), fs.realpathSync(setup.runtime()));
  put(path.join(setup.root, 'config/settings.json'), '{"defaultModel":"not-applied"}');
  // There is no Git repository here. Starting pi must not invoke the setup at all.
  const result = spawnSync(path.join(setup.bin, 'pi'), ['--print', "a prompt's value", '--no-session'], { cwd: temp, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(json(path.join(setup.agent, 'settings.json')).defaultModel, 'first');
  const calls = get(path.join(setup.homeDir, 'calls.jsonl')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0].args, ['update', '--extensions', '--no-approve']);
  assert.equal(calls[0].ignoreScripts, 'true');
  assert.deepEqual(calls.at(-1).args, ['--print', "a prompt's value", '--no-session']);
  assert.equal(calls.at(-1).cwd, fs.realpathSync(temp));
});

test('npm installation stages a private versioned runtime without changing global npm', t => {
  const { setup, temp } = fixture(t);
  const fakeBin = path.join(temp, 'fake-bin');
  const npm = path.join(fakeBin, 'npm');
  put(npm, `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path';\nconst args=process.argv.slice(2); const prefix=args[args.indexOf('--prefix')+1];\nif(!args.includes('--ignore-scripts')) process.exit(2);\nfs.mkdirSync(path.join(prefix,'node_modules/.bin'),{recursive:true}); fs.writeFileSync(path.join(prefix,'node_modules/.bin/pi'),'fake-runtime');\n`);
  fs.chmodSync(npm, 0o755);
  setup.env.PATH = `${fakeBin}${path.delimiter}${setup.env.PATH}`;
  setup.installRuntime();
  assert.equal(get(setup.runtime()), 'fake-runtime');
  assert.deepEqual(fs.readdirSync(path.join(setup.homeDir, 'runtimes')), ['pi-1.1.0']);
  setup.installRuntime();
});

test('repository updates are fetched and applied only by an explicit update command', t => {
  const { setup, writer, root, env } = remoteFixture(t);
  commitModel(writer, 'second');
  git(writer, 'push');
  const before = git(root, 'rev-parse', 'HEAD');
  const launch = spawnSync(path.join(setup.bin, 'pi'), ['--version'], { env, encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
  assert.equal(json(path.join(setup.agent, 'settings.json')).defaultModel, 'first');
  const update = spawnSync(path.join(setup.bin, 'pi-setup'), ['update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr);
  assert.equal(json(path.join(setup.agent, 'settings.json')).defaultModel, 'second');
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('manual update refuses diverging history instead of resetting local commits', t => {
  const { setup, writer, root, env } = remoteFixture(t);
  commitModel(writer, 'remote');
  git(writer, 'push');
  commitModel(root, 'local');
  const update = spawnSync(path.join(setup.bin, 'pi-setup'), ['update'], { env, encoding: 'utf8' });
  assert.notEqual(update.status, 0);
  assert.equal(json(path.join(root, 'config/settings.json')).defaultModel, 'local');
  assert.equal(json(path.join(setup.agent, 'settings.json')).defaultModel, 'first');
});
