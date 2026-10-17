import {createServer} from 'node:net';
import {mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath, readdir, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import zlib from 'node:zlib';
import {expect, it} from 'vitest';
import type {AgentPaths} from '../packages/core/src/agent-connections.js';
import {ConversationHandoff, handoffAgents, handoffRoots, projectFolder, type HandoffAgent} from '../packages/core/src/conversation-handoff.js';
import {createDesktopService} from '../packages/core/src/service.js';

const secret = 'SECRET-DEVELOPER-PROMPT';
const task = '请把登录按钮修好';
const progress = '按钮事件还没接上';

function agentPaths(home: string): AgentPaths {
  return {
    pi: join(home, '.pi', 'agent', 'models.json'),
    deepseek: join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
    qoder: join(home, '.qoder', 'settings.json'),
    codex: join(home, '.codex', 'config.toml'),
    claude: join(home, '.claude', 'settings.json'),
    workbuddy: join(home, '.workbuddy', 'models.json'),
  };
}

async function fixture() {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'handoff-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace, {recursive: true});
  await writeFile(join(workspace, 'keep.txt'), 'keep-marker');
  const paths = agentPaths(home);
  return {home, workspace: await realpath(workspace), paths, handoff: new ConversationHandoff(home, paths)};
}

function line(value: unknown) {return `${JSON.stringify(value)}\n`;}

async function writeCodex(home: string, workspace: string) {
  const file = join(home, '.codex', 'sessions', '2026', '10', '17', 'rollout-test.jsonl');
  await mkdir(dirname(file), {recursive: true});
  const rows = [
    {timestamp: '2026-10-17T00:00:00.000Z', type: 'session_meta', payload: {id: '11111111-1111-4111-8111-111111111111', cwd: workspace, base_instructions: {text: secret}}},
    {timestamp: '2026-10-17T00:00:01.000Z', type: 'response_item', payload: {type: 'message', role: 'developer', content: [{type: 'input_text', text: secret}]}},
    {timestamp: '2026-10-17T00:00:02.000Z', type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: task}]}},
    {timestamp: '2026-10-17T00:00:03.000Z', type: 'response_item', payload: {type: 'message', role: 'assistant', content: [{type: 'output_text', text: progress}]}},
    {timestamp: '2026-10-17T00:00:04.000Z', type: 'response_item', payload: {type: 'function_call', name: 'read_file', arguments: '{"path":"src/button.ts"}'}},
  ];
  await writeFile(file, rows.map(line).join(''));
  return file;
}

function codexIndex(home: string) {
  const database = join(home, '.codex', 'state_5.sqlite');
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL,
    has_user_event INTEGER NOT NULL, archived INTEGER NOT NULL, cli_version TEXT NOT NULL,
    first_user_message TEXT NOT NULL, memory_mode TEXT NOT NULL, preview TEXT NOT NULL,
    recency_at INTEGER NOT NULL, recency_at_ms INTEGER NOT NULL, history_mode TEXT NOT NULL,
    is_pinned INTEGER NOT NULL, created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, originator TEXT)`);
  db.close();
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string) => {
    let entries;
    try {entries = await readdir(current, {withFileTypes: true});} catch {return;}
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else found.push(path);
    }
  };
  await visit(dir);
  return found;
}

async function textOf(files: string[]) {
  const parts: string[] = [];
  for (const file of files) {
    const buffer = await readFile(file);
    parts.push(file.endsWith('.zstd') ? zlib.zstdDecompressSync(buffer).toString('utf8') : buffer.toString('utf8'));
  }
  return parts.join('\n');
}

it('names project folders the way each agent stores them', () => {
  expect(projectFolder('claude', '/Users/why')).toBe('-Users-why');
  expect(projectFolder('qoder', '/Users/why/Documents/platform')).toBe('-Users-why-Documents-platform');
  expect(projectFolder('workbuddy', '/Users/why/Documents/miniprogram/huli')).toBe('Users-why-Documents-miniprogram-huli');
  expect(projectFolder('workbuddy-ai', '/Users/why/whyself/miniprogram/TokenFlow')).toBe('Users-why-whyself-miniprogram-TokenFlow');
  expect(projectFolder('pi', '/Users/why')).toBe('--Users-why--');
  expect(projectFolder('deepseek', '/Users/why/whyself/miniprogram/TokenFlow')).toBe('--Users-why-whyself-miniprogram-TokenFlow--');
});

it('copies a Codex conversation into every other agent without the project tree or hidden prompts', async () => {
  const {home, workspace, paths, handoff} = await fixture();
  try {
    const source = await writeCodex(home, workspace);
    const before = await readFile(source);
    const listed = await handoff.list('codex');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({title: task, workspace, messages: 2});
    expect(JSON.stringify(listed)).not.toContain(secret);
    for (const target of handoffAgents.filter(agent => agent !== 'codex')) {
      const root = handoffRoots(paths)[target].root;
      const existing = new Set(await walk(root));
      const result = await handoff.transfer({source: 'codex', id: listed[0].id, target});
      expect(result).toMatchObject({source: 'codex', target, workspace, truncated: false});
      expect(result.title.startsWith('继续：')).toBe(true);
      expect(result.note).toBeUndefined();
      const created = (await walk(root)).filter(file => !existing.has(file));
      expect(created.length).toBeGreaterThan(0);
      const text = await textOf(created);
      expect(text).toContain(task);
      expect(text).toContain(progress);
      expect(text).toContain('read_file');
      expect(text).toContain(workspace);
      expect(text).toContain('还没有完成');
      expect(text).not.toContain(secret);
      expect(text).not.toContain('keep-marker');
    }
    expect(await readFile(source)).toEqual(before);
    expect(await readFile(join(workspace, 'keep.txt'), 'utf8')).toBe('keep-marker');
    const journal = await readFile(join(home, 'conversation-handoffs.json'), 'utf8');
    expect(journal).not.toContain(secret);
    expect(journal).toContain(workspace);
  } finally {await rm(home, {recursive: true, force: true});}
});

it('indexes a Codex destination when its thread database already exists', async () => {
  const {home, workspace, handoff} = await fixture();
  try {
    await writeCodex(home, workspace);
    codexIndex(home);
    const listed = await handoff.list('codex');
    const result = await handoff.transfer({source: 'codex', id: listed[0].id, target: 'claude'});
    await handoff.transfer({source: 'claude', id: (await handoff.list('claude'))[0].id, target: 'codex'});
    const db = new DatabaseSync(join(home, '.codex', 'state_5.sqlite'), {readOnly: true});
    const row = db.prepare('SELECT cwd, title, archived FROM threads').get() as {cwd: string; title: string; archived: number};
    db.close();
    expect(row.cwd).toBe(workspace);
    expect(row.title.startsWith('继续：')).toBe(true);
    expect(row.archived).toBe(0);
    expect(result.target).toBe('claude');
  } finally {await rm(home, {recursive: true, force: true});}
});

it('reads Claude, Qoder, WorkBuddy, Pi and DeepSeek transcripts', async () => {
  const {home, workspace, paths, handoff} = await fixture();
  const cases: {agent: HandoffAgent; file: string; body: Buffer | string; title?: string}[] = [
    {agent: 'claude', file: join(handoffRoots(paths).claude.root, '-proj', 'one.jsonl'), body: [line({type: 'user', cwd: workspace, message: {role: 'user', content: [{type: 'text', text: task}]}}), line({type: 'assistant', cwd: workspace, message: {role: 'assistant', content: [{type: 'text', text: progress}, {type: 'tool_use', name: 'read_file', input: {path: 'src/button.ts'}}]}})].join('')},
    {agent: 'qoder', file: join(handoffRoots(paths).qoder.root, '-proj', 'transcript', 'one.jsonl'), body: [line({type: 'session_meta', cwd: workspace, sessionId: 'one'}), line({type: 'user', cwd: workspace, message: {role: 'user', content: task}}), line({type: 'assistant', cwd: workspace, message: {role: 'assistant', content: [{type: 'thinking', text: secret}, {type: 'text', text: progress}]}})].join('')},
    {agent: 'workbuddy', file: join(handoffRoots(paths).workbuddy.root, 'proj', 'one.jsonl'), title: '修好登录', body: [line({type: 'custom-title', customTitle: '修好登录', sessionId: 'one'}), line({type: 'message', role: 'user', cwd: workspace, sessionId: 'one', content: [{type: 'input_text', text: task}]}), line({type: 'message', role: 'assistant', cwd: workspace, sessionId: 'one', content: [{type: 'output_text', text: progress}]}), line({type: 'function_call', name: 'edit', arguments: '{"file":"src/button.ts"}', sessionId: 'one'})].join('')},
    {agent: 'pi', file: join(handoffRoots(paths).pi.root, '--proj--', 'one.jsonl'), body: [line({type: 'session', cwd: workspace, id: 'one'}), line({type: 'message', message: {role: 'system', content: secret}}), line({type: 'message', message: {role: 'user', content: [{type: 'text', text: task}]}}), line({type: 'message', message: {role: 'assistant', content: [{type: 'text', text: progress}]}})].join('')},
    {agent: 'deepseek', file: join(handoffRoots(paths).deepseek.root, '--proj--', 'session-one', 'session.v4.jsonl.zstd'), body: Buffer.concat([line({type: 'session', cwd: workspace, id: 'session-one'}), line({type: 'user/message', data: {content: [{type: 'text', text: task}], role: 'user'}}), line({type: 'assistant/message', data: {message: {role: 'assistant', content: [{type: 'text', text: progress}, {type: 'reasoning', text: secret}]}}}), line({type: 'system/message', data: {message: {role: 'system', content: [{type: 'text', text: secret}]}}})].map(item => zlib.zstdCompressSync(Buffer.from(item))))},
  ];
  try {
    for (const item of cases) {
      await mkdir(dirname(item.file), {recursive: true});
      await writeFile(item.file, item.body);
      const listed = await handoff.list(item.agent);
      expect(listed.map(conversation => conversation.title)).toContain(item.title ?? task);
      const conversation = listed.find(entry => entry.title === (item.title ?? task));
      const target: HandoffAgent = item.agent === 'claude' ? 'pi' : 'claude';
      const result = await handoff.transfer({source: item.agent, id: conversation!.id, target});
      const created = (await walk(handoffRoots(paths)[target].root)).filter(file => /\.jsonl(?:\.zstd)?$/.test(file) || file.endsWith('.meta.json'));
      const text = await textOf(created);
      expect(text).toContain(task);
      expect(text).toContain(progress);
      expect(text).not.toContain(secret);
      expect(result.workspace).toBe(workspace);
      await rm(handoffRoots(paths)[target].root, {recursive: true, force: true});
    }
  } finally {await rm(home, {recursive: true, force: true});}
});

it('keeps the opening request when the transcript is too long and reports a missing Codex index', async () => {
  const {home, workspace, paths, handoff} = await fixture();
  try {
    const file = join(home, '.codex', 'sessions', '2026', '10', '17', 'rollout-long.jsonl');
    await mkdir(dirname(file), {recursive: true});
    const rows: unknown[] = [{timestamp: '2026-10-17T00:00:00.000Z', type: 'session_meta', payload: {id: 'long', cwd: workspace}}, {timestamp: '2026-10-17T00:00:01.000Z', type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: '开头任务唯一标记'}]}}];
    for (let index = 0; index < 120; index += 1) rows.push({timestamp: '2026-10-17T00:00:02.000Z', type: 'response_item', payload: {type: 'message', role: index % 2 === 0 ? 'assistant' : 'user', content: [{type: index % 2 === 0 ? 'output_text' : 'input_text', text: `中间${index} ${'x'.repeat(800)}`}]}});
    rows.push({timestamp: '2026-10-17T00:00:03.000Z', type: 'response_item', payload: {type: 'message', role: 'assistant', content: [{type: 'output_text', text: '最近停在这里'}]}});
    await writeFile(file, rows.map(line).join(''));
    const listed = await handoff.list('codex');
    const result = await handoff.transfer({source: 'codex', id: listed[0].id, target: 'claude'});
    expect(result.truncated).toBe(true);
    expect(result.note).toContain('截断');
    const text = await textOf(await walk(handoffRoots(paths).claude.root));
    expect(text).toContain('开头任务唯一标记');
    expect(text).toContain('最近停在这里');
    expect(text).not.toContain('中间0');
    const back = await handoff.transfer({source: 'claude', id: (await handoff.list('claude'))[0].id, target: 'codex'});
    expect(back.note).toContain('会话索引');
  } finally {await rm(home, {recursive: true, force: true});}
});

it('streams a large transcript and does not keep the oversized line', async () => {
  const {home, workspace, paths, handoff} = await fixture();
  try {
    const file = join(home, '.codex', 'sessions', '2026', '10', '17', 'rollout-large.jsonl');
    await mkdir(dirname(file), {recursive: true});
    let body = line({timestamp: '2026-10-17T00:00:00.000Z', type: 'session_meta', payload: {id: 'large', cwd: workspace}});
    body += line({timestamp: '2026-10-17T00:00:01.000Z', type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: '开头任务唯一标记'}]}});
    body += line({timestamp: '2026-10-17T00:00:02.000Z', type: 'response_item', payload: {type: 'message', role: 'assistant', content: [{type: 'output_text', text: '超大行'.repeat(90_000)}]}});
    for (let index = 0; index < 400; index += 1) {
      const role = index % 2 === 0 ? 'assistant' : 'user';
      body += line({timestamp: '2026-10-17T00:00:03.000Z', type: 'response_item', payload: {type: 'message', role, content: [{type: role === 'user' ? 'input_text' : 'output_text', text: `中间丢弃${index} ${'y'.repeat(700)}`}]}});
    }
    body += line({timestamp: '2026-10-17T00:00:04.000Z', type: 'response_item', payload: {type: 'message', role: 'assistant', content: [{type: 'output_text', text: '最近停在这里'}]}});
    await writeFile(file, body);
    const listed = await handoff.list('codex');
    expect(listed[0].partial).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('超大行');
    expect(JSON.stringify(listed)).not.toContain('中间丢弃0');
    const result = await handoff.transfer({source: 'codex', id: listed[0].id, target: 'claude'});
    expect(result.truncated).toBe(true);
    const saved = await textOf(await walk(handoffRoots(paths).claude.root));
    expect(saved).toContain('开头任务唯一标记');
    expect(saved).toContain('最近停在这里');
    expect(saved).not.toContain('超大行');
    expect(saved).not.toContain('中间丢弃0');
    expect(Buffer.byteLength(saved)).toBeLessThan(200_000);
  } finally {await rm(home, {recursive: true, force: true});}
});

it('refuses the same agent, a missing workspace, path traversal and symlink sessions', async () => {
  const {home, workspace, handoff} = await fixture();
  try {
    const source = await writeCodex(home, workspace);
    const listed = await handoff.list('codex');
    await expect(handoff.transfer({source: 'codex', id: listed[0].id, target: 'codex'})).rejects.toThrow('另一个 Agent');
    await expect(handoff.transfer({source: 'codex', id: '../../secret.jsonl', target: 'claude'})).rejects.toThrow('对话标识无效');
    const outside = join(home, 'outside.jsonl');
    await writeFile(outside, line({type: 'session_meta', payload: {cwd: workspace, id: 'x'}}));
    const link = join(dirname(source), 'linked.jsonl');
    await symlink(outside, link);
    await expect(handoff.transfer({source: 'codex', id: '2026/10/17/linked.jsonl', target: 'claude'})).rejects.toThrow('对话标识无效');
    expect((await handoff.list('codex')).map(item => item.id)).not.toContain('2026/10/17/linked.jsonl');
    const missing = join(home, '.claude', 'projects', '-missing', 'one.jsonl');
    await mkdir(dirname(missing), {recursive: true});
    await writeFile(missing, line({type: 'user', cwd: join(home, 'missing-workspace'), message: {role: 'user', content: task}}));
    const orphan = (await handoff.list('claude')).find(item => item.workspace.endsWith('missing-workspace'));
    expect(orphan).toBeTruthy();
    await expect(handoff.transfer({source: 'claude', id: orphan!.id, target: 'pi'})).rejects.toThrow('工作区');
  } finally {await rm(home, {recursive: true, force: true});}
});

it('serves handoff only to the local administrator and does not return the transcript', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'handoff-api-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace, {recursive: true});
  const paths = agentPaths(home);
  await writeCodex(home, await realpath(workspace));
  const allocator = createServer();
  await new Promise<void>(resolveListen => allocator.listen(0, '127.0.0.1', resolveListen));
  const port = (allocator.address() as {port: number}).port;
  await new Promise<void>(resolveClose => allocator.close(() => resolveClose()));
  await mkdir(join(home, 'cliproxy'), {recursive: true});
  await writeFile(join(home, 'cliproxy', 'fixture-accounts.json'), '[]');
  const service = await createDesktopService({root: home, proxyPort: port, binary: resolve('tests/fixtures/fake-cliproxy.mjs'), token: 'admin-token', localKey: 'internal-key', secrets: {get: async () => '', set: async () => {}}, agentPaths: paths, agentProcesses: async () => []});
  const headers = {host: '127.0.0.1:9527', authorization: 'Bearer admin-token'};
  try {
    expect((await service.app.inject({url: '/api/a2a/conversations?agent=codex', headers: {host: headers.host}})).statusCode).toBe(401);
    expect((await service.app.inject({method: 'POST', url: '/api/a2a/handoff', headers: {host: headers.host}, payload: {source: 'codex', id: '2026/10/17/rollout-test.jsonl', target: 'pi'}})).statusCode).toBe(401);
    const listed = await service.app.inject({url: '/api/a2a/conversations?agent=codex', headers});
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(secret);
    const id = listed.json().conversations[0].id as string;
    const moved = await service.app.inject({method: 'POST', url: '/api/a2a/handoff', headers, payload: {source: 'codex', id, target: 'pi'}});
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.body).toContain('继续：');
    expect(moved.body).not.toContain(secret);
    expect(moved.body).not.toContain(progress);
    const saved = await stat(join(handoffRoots(paths).pi.root, projectFolder('pi', await realpath(workspace))));
    expect(saved.isDirectory()).toBe(true);
  } finally {
    await service.app.close();
    await rm(home, {recursive: true, force: true});
  }
});
