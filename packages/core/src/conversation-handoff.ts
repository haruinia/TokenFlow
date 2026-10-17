import {chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile, realpath} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep} from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {z} from 'zod';
import zlib from 'node:zlib';
import {deepseekHome} from './deepseek-config.js';
import type {AgentPaths} from './agent-connections.js';
import {handoffAgents, handoffNames, type HandoffAgent, type HandoffConversation, type HandoffResult} from './conversation-handoff-shared.js';

export {handoffAgents, handoffNames, isHandoffAgent} from './conversation-handoff-shared.js';
export type {HandoffAgent, HandoffConversation, HandoffResult} from './conversation-handoff-shared.js';

export const handoffAgentSchema = z.enum(handoffAgents as unknown as [HandoffAgent, ...HandoffAgent[]]);
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_MESSAGES = 80;
const MAX_CHARS = 60_000;
const MAX_MESSAGE = 6_000;
const ZSTD_MAGIC = 0xfd2fb528;
// V8 slices from split/slice keep the parent string alive. A copied title or
// turn must not pin the session that produced it.
type Turn = {role: 'user' | 'assistant'; text: string};
type Column = {name: string; notnull: number; dflt_value: string | null};
type Zstd = typeof zlib & {zstdCompressSync?: (buffer: Buffer) => Buffer; createZstdDecompress?: () => ZstdDecoder};
type ZstdDecoder = {write: (chunk: Buffer) => boolean; end: () => void; destroy: () => void; on: (event: 'data' | 'error' | 'end', listener: (value?: unknown) => void) => void; once: (event: 'drain', listener: () => void) => void};
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), {statusCode});

type Root = {root: string; archived?: string};
export function handoffRoots(paths: AgentPaths): Record<HandoffAgent, Root> {
  const codexHome = dirname(paths.codex);
  const workbuddyHome = dirname(paths.workbuddy);
  return {
    codex: {root: join(codexHome, 'sessions'), archived: join(codexHome, 'archived_sessions')},
    claude: {root: join(dirname(paths.claude), 'projects')},
    qoder: {root: join(dirname(paths.qoder), 'projects')},
    workbuddy: {root: join(workbuddyHome, 'projects')},
    'workbuddy-ai': {root: join(dirname(workbuddyHome), '.workbuddy-ai', 'projects')},
    pi: {root: join(dirname(paths.pi), 'sessions')},
    deepseek: {root: join(deepseekHome(paths.deepseek), 'sessions')},
  };
}

/** Session directory name each client derives from a workspace path. */
export function projectFolder(agent: HandoffAgent, workspace: string): string {
  const normalized = workspace.replaceAll('\\', '/');
  if (agent === 'pi' || agent === 'deepseek') {
    const body = normalized.replace(/^\//, '').replaceAll(/[^A-Za-z0-9]/g, '-').replace(/-+$/g, '');
    return `--${body}--`;
  }
  const dashed = normalized.replaceAll(/[^A-Za-z0-9]/g, '-');
  return agent === 'workbuddy' || agent === 'workbuddy-ai' ? dashed.replace(/^-+/, '') : dashed;
}

export class ConversationHandoff {
  constructor(private dataRoot: string, private paths: AgentPaths) {}

  async list(agent?: HandoffAgent): Promise<HandoffConversation[]> {
    const agents = agent ? [agent] : [...handoffAgents];
    const found: HandoffConversation[] = [];
    for (const current of agents) {
      const roots = handoffRoots(this.paths)[current];
      const files = [...await collect(roots.root, false), ...roots.archived ? await collect(roots.archived, true) : []];
      files.sort((a, b) => b.mtime - a.mtime);
      for (const file of files.slice(0, 40)) {
        try {
          const summary = await summarize(current, file);
          if (summary) found.push(summary);
        } catch { /* A damaged session stays out of the list. */ }
      }
    }
    return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async transfer(input: {source: HandoffAgent; id: string; target: HandoffAgent}): Promise<HandoffResult> {
    if (input.source === input.target) throw fail('请选择另一个 Agent。原来的对话会保留。');
    const loaded = await this.load(input.source, input.id);
    const workspace = await workspaceDirectory(loaded.cwd);
    const truncated = loaded.partial;
    const prompt = continuation(input.source, workspace, truncated);
    const turns = withContinuation(loaded.turns, prompt);
    const title = oneLine(`继续：${loaded.title}`, 80);
    const written = await writeSession(handoffRoots(this.paths)[input.target].root, input.target, {title, workspace, turns, now: Date.now()});
    const indexNote = input.target === 'codex' ? await indexCodex(dirname(handoffRoots(this.paths).codex.root), written.file, {id: written.id, title, workspace, at: Date.now()}) : undefined;
    const notes = [truncated ? '较早的内容已截断，保留了任务开头和最近的记录。' : '', indexNote ?? ''].filter(Boolean);
    try {await this.remember({at: new Date().toISOString(), source: input.source, target: input.target, title, workspace, messages: loaded.turns.length, truncated});}
    catch {notes.push('交接记录没有写入，对话文件已经保存。');}
    return {source: input.source, target: input.target, title, workspace, messages: loaded.turns.length, truncated, ...notes.length ? {note: notes.join('')} : {}};
  }

  private async load(agent: HandoffAgent, id: string) {
    const located = await locate(handoffRoots(this.paths)[agent], id);
    const parsed = await scanFile(agent, located.file, 'transfer');
    if (!parsed.turns.length || !parsed.cwd || !isAbsolute(parsed.cwd)) throw fail('这段对话里没有可继续的内容和工作区。');
    return {...parsed, title: parsed.title || '未命名对话'};
  }

  private async remember(entry: {at: string; source: HandoffAgent; target: HandoffAgent; title: string; workspace: string; messages: number; truncated: boolean}) {
    const file = join(this.dataRoot, 'conversation-handoffs.json');
    await assertContained(file);
    await mkdir(dirname(file), {recursive: true, mode: 0o700});
    let previous: unknown[] = [];
    try {previous = z.array(z.unknown()).parse(JSON.parse(await readFile(file, 'utf8')));} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') previous = [];}
    const body = JSON.stringify([entry, ...previous].slice(0, 50), null, 2);
    await writePrivate(file, body);
  }
}

function continuation(source: HandoffAgent, workspace: string, truncated: boolean) {
  return `${truncated ? '较早的对话已截断。' : ''}这段对话从${handoffNames[source]}转来，原来的任务还没有完成。工作区是 ${workspace}。请在这个目录从现有进度继续，不要重做已经完成的部分。`;
}

async function locate(roots: Root, id: string) {
  const archived = id.startsWith('archived:');
  if (archived && !roots.archived) throw fail('对话标识无效。');
  const body = archived ? id.slice('archived:'.length) : id;
  const parts = body.split('/');
  if (!parts.length || parts.some(part => part === '.' || part === '..' || !/^[A-Za-z0-9._+-]+$/.test(part))) throw fail('对话标识无效。');
  const root = archived ? roots.archived! : roots.root;
  let rootReal: string;
  try {rootReal = await realpath(root);} catch {throw fail('找不到这段对话，可能已被移动或删除。', 404);}
  const file = resolve(rootReal, ...parts);
  let real: string;
  try {real = await realpath(file);} catch {throw fail('找不到这段对话，可能已被移动或删除。', 404);}
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (!real.startsWith(prefix)) throw fail('对话标识无效。');
  return {file: real, archived};
}

async function collect(root: string, archived: boolean) {
  const files: {file: string; id: string; mtime: number; size: number}[] = [];
  const visit = async (dir: string, depth: number) => {
    if (depth > 6 || files.length > 8000) return;
    let entries;
    try {entries = await readdir(dir, {withFileTypes: true});} catch {return;}
    for (const entry of entries) {
      if (entry.isSymbolicLink() || files.length > 8000) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'memory' && entry.name !== 'node_modules') await visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.jsonl(?:\.zstd)?$/.test(entry.name)) continue;
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const idBody = relative(root, path).split(sep).join('/');
        if (!idBody || idBody.startsWith('..')) continue;
        files.push({file: path, id: archived ? `archived:${idBody}` : idBody, mtime: stat.mtimeMs, size: stat.size});
      } catch { /* A file removed during the scan is simply absent. */ }
    }
  };
  await visit(root, 0);
  return files;
}

async function summarize(agent: HandoffAgent, file: {file: string; id: string; mtime: number; size: number}): Promise<HandoffConversation | undefined> {
  const parsed = await scanFile(agent, file.file, 'list');
  if (!parsed.messages || !parsed.cwd || !isAbsolute(parsed.cwd)) return;
  const updated = parsed.updated || file.mtime;
  return {id: file.id, agent, title: parsed.title || '未命名对话', workspace: parsed.cwd, updatedAt: new Date(updated).toISOString(), messages: parsed.messages, partial: parsed.partial || file.size > MAX_LIST_BYTES};
}

type Side = {count: number; tail?: 'user' | 'assistant'; opening: string; userOpen: boolean; userDone: boolean; turns: Turn[]; firstUser?: Turn; truncated: boolean};
type Scan = {cwd: string; title: string; updated: number; partial: boolean; dialog: Side; events: Side};

function blankSide(): Side {return {count: 0, opening: '', userOpen: false, userDone: false, turns: [], truncated: false};}

async function scanFile(agent: HandoffAgent, file: string, mode: 'list' | 'transfer') {
  await assertContained(file);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('对话记录不是可读取的文件。');
  const scan: Scan = {cwd: '', title: '', updated: 0, partial: false, dialog: blankSide(), events: blankSide()};
  const keep = mode === 'transfer';
  const limit = mode === 'list' ? MAX_LIST_BYTES : Number.POSITIVE_INFINITY;
  const lines = lineFeed(line => absorbLine(agent, line, scan, keep));
  if (file.endsWith('.jsonl.zstd')) await readCompressed(file, stat.size, limit, lines);
  else await readPlain(file, stat.size, limit, lines);
  const used = (keep ? scan.dialog.turns.length : scan.dialog.count) ? scan.dialog : scan.events;
  return {turns: used.turns, cwd: scan.cwd, title: oneLine(scan.title || used.opening, 80), updated: scan.updated, partial: scan.partial || lines.partial || (keep && used.truncated), messages: keep ? used.turns.length : used.count};
}

function absorbLine(agent: HandoffAgent, line: string, scan: Scan, keep: boolean) {
  let row: unknown;
  try {row = JSON.parse(line);} catch {return;}
  if (!row || typeof row !== 'object') return;
  const record = row as Record<string, unknown>;
  const payload = objectOf(record.payload);
  const data = objectOf(record.data);
  const message = objectOf(record.message);
  const seen = (value: unknown) => {const time = millis(value); if (time > scan.updated) scan.updated = time;};
  const rememberCwd = (value: unknown) => {if (!scan.cwd && typeof value === 'string') scan.cwd = detached(value);};
  const rememberTitle = (value: unknown) => {if (!scan.title && typeof value === 'string') scan.title = oneLine(value, 80);};
  seen(record.timestamp ?? record.time ?? record.createdAt);
  rememberCwd(record.cwd);
  const say = (side: Side, role: 'user' | 'assistant', text: string) => note(side, role, text, keep);
  if (agent === 'codex') {
    if (record.type === 'session_meta' && payload) {rememberCwd(payload.cwd); seen(payload.timestamp);}
    if (record.type === 'response_item' && payload) {
      if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) say(scan.dialog, payload.role, textContent(payload.content));
      else if (payload.type === 'function_call' || payload.type === 'custom_tool_call' || payload.type === 'tool_call') say(scan.dialog, 'assistant', toolText(payload.name, payload.arguments ?? payload.input));
      else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') say(scan.dialog, 'assistant', resultText(payload.output ?? payload.content));
    }
    if (record.type === 'event_msg' && payload && typeof payload.message === 'string') {
      if (payload.type === 'user_message') say(scan.events, 'user', payload.message);
      if (payload.type === 'agent_message') say(scan.events, 'assistant', payload.message);
    }
    return;
  }
  if (agent === 'deepseek') {
    if (record.type === 'session') rememberCwd(record.cwd);
    if (record.type === 'session/title') rememberTitle(data?.title);
    if (record.type === 'user/message') say(scan.dialog, 'user', textContent(data?.content));
    if (record.type === 'assistant/message') say(scan.dialog, 'assistant', textContent(objectOf(data?.message)?.content, true));
    if (record.type === 'tool/call') say(scan.dialog, 'assistant', toolText(data?.name, data?.arguments));
    if (record.type === 'tool/result') say(scan.dialog, 'assistant', resultText(objectOf(data?.message)?.content));
    return;
  }
  if (agent === 'pi') {
    if (record.type === 'session') rememberCwd(record.cwd);
    if (record.type === 'message' && (message?.role === 'user' || message?.role === 'assistant')) say(scan.dialog, message.role, textContent(message.content));
    return;
  }
  if (agent === 'workbuddy' || agent === 'workbuddy-ai') {
    if (record.type === 'custom-title') rememberTitle(record.customTitle);
    if (record.type === 'ai-title') rememberTitle(record.aiTitle);
    if (record.type === 'message' && (record.role === 'user' || record.role === 'assistant')) say(scan.dialog, record.role, textContent(record.content));
    if (record.type === 'function_call') say(scan.dialog, 'assistant', toolText(record.name, record.arguments));
    if (record.type === 'function_call_result') say(scan.dialog, 'assistant', resultText(record.output ?? record.content ?? record.result));
    return;
  }
  if (record.type === 'session_meta') rememberCwd(record.cwd);
  if ((record.type === 'user' || record.type === 'assistant') && (message?.role === 'user' || message?.role === 'assistant')) say(scan.dialog, message.role, textContent(message.content));
}

function note(side: Side, role: 'user' | 'assistant', text: string, keep: boolean) {
  const clean = text.replaceAll('\u0000', '').trim();
  if (!clean) return;
  if (!side.userDone && role === 'user') {
    side.opening = oneLine(side.opening ? `${side.opening}\n${clean}` : clean, 80);
    side.userOpen = true;
  } else if (side.userOpen && role !== 'user') side.userDone = true;
  if (!keep) {
    if (side.tail === role) return;
    side.tail = role;
    side.count += 1;
    return;
  }
  const clipped = detached(clean.length > MAX_MESSAGE ? clean.slice(0, MAX_MESSAGE) : clean);
  if (clipped.length < clean.length) side.truncated = true;
  const last = side.turns.at(-1);
  if (last?.role === role) {
    const merged = `${last.text}\n${clipped}`;
    last.text = detached(merged.length > MAX_MESSAGE ? merged.slice(0, MAX_MESSAGE) : merged);
    if (last.text.length < merged.length) side.truncated = true;
    trimSide(side);
    return;
  }
  const turn = {role, text: clipped};
  side.turns.push(turn);
  if (role === 'user' && !side.firstUser) side.firstUser = turn;
  trimSide(side);
}

function trimSide(side: Side) {
  const weight = () => side.turns.reduce((sum, turn) => sum + turn.text.length, 0);
  while (side.turns.length > MAX_MESSAGES || weight() > MAX_CHARS) {
    side.truncated = true;
    if (side.turns.length <= 1) {
      const only = side.turns[0];
      side.turns[0] = {role: only.role, text: detached(only.text.slice(0, MAX_CHARS))};
      if (side.firstUser === only) side.firstUser = side.turns[0];
      break;
    }
    side.turns.splice(side.firstUser && side.turns[0] === side.firstUser ? 1 : 0, 1);
  }
  if (side.truncated && side.firstUser && !side.turns.includes(side.firstUser)) side.turns.unshift(side.firstUser);
}

type LineFeed = {partial: boolean; pending: Buffer; skip: boolean; onLine: (line: string) => void};

function lineFeed(onLine: (line: string) => void): LineFeed {
  return {partial: false, pending: Buffer.alloc(0), skip: false, onLine};
}

function pushChunk(feed: LineFeed, chunk: Buffer, flush: boolean) {
  let input = chunk;
  if (feed.skip) {
    const newline = input.indexOf(0x0a);
    if (newline < 0) return;
    feed.skip = false;
    input = input.subarray(newline + 1);
  }
  if (!input.length && !flush) return;
  const pending = feed.pending.length ? Buffer.concat([feed.pending, input]) : input;
  let start = 0;
  while (true) {
    const newline = pending.indexOf(0x0a, start);
    if (newline < 0) break;
    const line = pending.subarray(start, newline);
    if (line.length > MAX_LINE_BYTES) feed.partial = true;
    else if (line.length) feed.onLine(line.toString('utf8'));
    start = newline + 1;
  }
  const rest = pending.subarray(start);
  if (!flush && rest.length > MAX_LINE_BYTES) {
    feed.partial = true;
    feed.skip = true;
    feed.pending = Buffer.alloc(0);
    return;
  }
  if (flush) {
    if (!feed.skip && rest.length && rest.length <= MAX_LINE_BYTES) feed.onLine(rest.toString('utf8'));
    else if (rest.length > MAX_LINE_BYTES) feed.partial = true;
    feed.pending = Buffer.alloc(0);
    return;
  }
  feed.pending = rest.length ? Buffer.from(rest) : Buffer.alloc(0);
}

async function readPlain(file: string, size: number, maxBytes: number, feed: LineFeed) {
  const handle = await open(file, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    const limit = Number.isFinite(maxBytes) ? Math.min(size, maxBytes) : size;
    while (offset < limit) {
      const {bytesRead} = await handle.read(chunk, 0, Math.min(chunk.length, limit - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
      pushChunk(feed, Buffer.from(chunk.subarray(0, bytesRead)), false);
    }
    if (size > offset) feed.partial = true;
    else pushChunk(feed, Buffer.alloc(0), true);
  } finally {await handle.close();}
}

function detached(text: string) {return Buffer.from(text, 'utf8').toString('utf8');}

function textContent(value: unknown, skipTools = false): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => textContent(item, skipTools)).filter(Boolean).join('\n');
  const row = objectOf(value);
  if (!row) return '';
  const type = typeof row.type === 'string' ? row.type : '';
  if (type === 'thinking' || type === 'reasoning') return '';
  if (type === 'tool_use' || type === 'tool_call' || type === 'tool-call') return skipTools ? '' : toolText(row.name, row.input ?? row.arguments);
  if (type === 'tool_result') return resultText(row.content ?? row.output);
  if (typeof row.text === 'string') return row.text;
  return '';
}

function toolText(name: unknown, args: unknown) {
  const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : '工具';
  const body = typeof args === 'string' ? args : args && typeof args === 'object' ? JSON.stringify(args) : '';
  return `[工具 ${label}]${body ? `\n${body.slice(0, 2000)}` : ''}`;
}
function resultText(value: unknown) {
  const text = textContent(value).slice(0, 2000);
  return text ? `[工具结果]\n${text}` : '';
}
function objectOf(value: unknown) {return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;}
function millis(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value > 1e9 ? value * 1000 : 0;
  if (typeof value === 'string') {const time = Date.parse(value); return Number.isFinite(time) ? time : 0;}
  return 0;
}
function oneLine(text: string, max: number) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return detached(flat.length > max ? flat.slice(0, max) : flat);
}

function withContinuation(turns: Turn[], note: string) {
  const copy = turns.map(turn => ({...turn}));
  const last = copy.at(-1);
  if (!last) copy.push({role: 'user', text: note});
  else if (last.role === 'user') last.text = `${last.text}\n\n${note}`;
  else copy.push({role: 'user', text: note});
  return copy;
}

async function workspaceDirectory(workspace: string) {
  if (!isAbsolute(workspace)) throw fail('对话里的工作区不是绝对路径。');
  let real: string;
  try {real = await realpath(workspace);} catch {throw fail('找不到这段对话的工作区，无法交给其他 Agent。');}
  const stat = await lstat(real);
  if (!stat.isDirectory()) throw fail('工作区不是目录，无法交给其他 Agent。');
  return real;
}

async function writeSession(root: string, agent: HandoffAgent, input: {title: string; workspace: string; turns: Turn[]; now: number}) {
  const id = randomUUID();
  const files = sessionFiles(root, agent, id, input);
  for (const file of files) await writePrivate(file.path, file.body);
  return {id, file: files[0].path};
}

function sessionFiles(root: string, agent: HandoffAgent, id: string, input: {title: string; workspace: string; turns: Turn[]; now: number}) {
  const folder = projectFolder(agent, input.workspace);
  if (agent === 'codex') {
    const date = new Date(input.now);
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    const rows: unknown[] = [{timestamp: new Date(input.now).toISOString(), type: 'session_meta', payload: {id, timestamp: new Date(input.now).toISOString(), cwd: input.workspace, originator: 'token_flow', cli_version: '0.0.0', source: 'cli', thread_source: 'user'}}];
    input.turns.forEach((turn, index) => rows.push({timestamp: new Date(input.now + index + 1).toISOString(), type: 'response_item', payload: {type: 'message', role: turn.role, content: [{type: turn.role === 'user' ? 'input_text' : 'output_text', text: turn.text}]}}));
    return [{path: join(root, String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()), `rollout-${stamp}-${id}.jsonl`), body: jsonl(rows)}];
  }
  if (agent === 'claude') {
    let parent: string | null = null;
    const rows = input.turns.map(turn => {
      const uuid = randomUUID();
      const row = {type: turn.role, uuid, parentUuid: parent, sessionId: id, timestamp: new Date(input.now).toISOString(), cwd: input.workspace, version: '0.0.0', userType: 'external', entrypoint: 'cli', isSidechain: false, message: {role: turn.role, content: [{type: 'text', text: turn.text}]}};
      parent = uuid;
      return row;
    });
    return [{path: join(root, folder, `${id}.jsonl`), body: jsonl(rows)}];
  }
  if (agent === 'qoder') {
    const rows: unknown[] = [{type: 'session_meta', sessionId: id, uuid: randomUUID(), timestamp: new Date(input.now).toISOString(), cwd: input.workspace, data: {meta_type: 'session_info', content: {mode: 'agent', session_type: 'assistant'}}}];
    for (const turn of input.turns) rows.push({type: turn.role, sessionId: id, uuid: randomUUID(), timestamp: new Date(input.now).toISOString(), cwd: input.workspace, message: {role: turn.role, content: turn.role === 'user' ? turn.text : [{type: 'text', text: turn.text}]}});
    return [{path: join(root, folder, 'transcript', `${id}.jsonl`), body: jsonl(rows)}];
  }
  if (agent === 'pi') {
    let parent: string | null = null;
    const rows: unknown[] = [{type: 'session', version: 3, id, timestamp: new Date(input.now).toISOString(), cwd: input.workspace}];
    for (const turn of input.turns) {
      const messageId = randomBytes(4).toString('hex');
      rows.push({type: 'message', id: messageId, parentId: parent, timestamp: new Date(input.now).toISOString(), message: {role: turn.role, content: [{type: 'text', text: turn.text}], timestamp: input.now}});
      parent = messageId;
    }
    const stamp = new Date(input.now).toISOString().replaceAll(':', '-').replaceAll('.', '-');
    return [{path: join(root, folder, `${stamp}_${id}.jsonl`), body: jsonl(rows)}];
  }
  if (agent === 'deepseek') {
    const sessionId = `session-${id}`;
    const rows: unknown[] = [{type: 'session', version: 4, id: sessionId, createdAt: input.now, cwd: input.workspace, isSeeded: false, delegationDepth: 0, agentPreset: 'cordis'}, {type: 'session/title', seq: 1, time: input.now, data: {title: input.title, messageSeqs: [2], source: {kind: 'imported'}}}];
    input.turns.forEach((turn, index) => {
      const content = [{type: 'text', text: turn.text}];
      rows.push(turn.role === 'user'
        ? {type: 'user/message', seq: index + 2, time: input.now + index, data: {content, source: {kind: 'user'}, role: 'user', id: randomUUID()}, surfaceOp: 'append'}
        : {type: 'assistant/message', seq: index + 2, time: input.now + index, data: {turn: 1, step: index + 1, message: {role: 'assistant', content, source: {kind: 'assistant'}, id: randomUUID()}}, surfaceOp: 'append'});
    });
    return [{path: join(root, folder, sessionId, 'session.v4.jsonl.zstd'), body: compressZstd(jsonl(rows))}];
  }
  let parent = '';
  const rows: unknown[] = [];
  for (const turn of input.turns) {
    const messageId = randomUUID();
    rows.push({id: messageId, ...parent ? {parentId: parent} : {}, timestamp: input.now, type: 'message', role: turn.role, sessionId: id, cwd: input.workspace, content: [{type: turn.role === 'user' ? 'input_text' : 'output_text', text: turn.text}]});
    parent = messageId;
  }
  rows.push(agent === 'workbuddy-ai'
    ? {id: randomUUID(), timestamp: input.now, type: 'ai-title', aiTitle: input.title, sessionId: id, cwd: input.workspace}
    : {id: randomUUID(), timestamp: input.now, type: 'custom-title', customTitle: input.title, sessionId: id, cwd: input.workspace});
  const meta = {createdAt: input.now, updatedAt: input.now, messageCount: input.turns.length, itemCount: rows.length, requestCount: input.turns.filter(turn => turn.role === 'user').length, isPlayground: false, cwd: input.workspace, model: 'handoff', source: 'tokenflow-handoff'};
  return [{path: join(root, folder, `${id}.jsonl`), body: jsonl(rows)}, {path: join(root, folder, `${id}.meta.json`), body: JSON.stringify(meta)}];
}

function jsonl(rows: unknown[]) {return `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;}

async function indexCodex(codexHome: string, rollout: string, input: {id: string; title: string; workspace: string; at: number}) {
  const database = join(codexHome, 'state_5.sqlite');
  try {const stat = await lstat(database); if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100) return 'Codex 会话索引未能更新。';}
  catch {return 'Codex 会话索引未能更新。';}
  try {
    const {DatabaseSync} = await import('node:sqlite');
    const db = new DatabaseSync(database);
    try {
      db.exec('PRAGMA busy_timeout=2000');
      const columns = db.prepare('PRAGMA table_info(threads)').all() as Column[];
      if (!columns.length) return 'Codex 会话索引未能更新。';
      const names = new Set(columns.map(column => column.name));
      let cli = '0.0.0';
      if (names.has('cli_version') && names.has('updated_at_ms')) {
        const row = db.prepare('SELECT cli_version FROM threads ORDER BY updated_at_ms DESC LIMIT 1').get() as {cli_version?: string} | undefined;
        if (typeof row?.cli_version === 'string' && row.cli_version.trim()) cli = row.cli_version.trim().slice(0, 80);
      }
      const seconds = Math.floor(input.at / 1000);
      const values: Record<string, string | number> = {
        id: input.id, rollout_path: rollout, created_at: seconds, updated_at: seconds, source: 'exec', model_provider: 'openai', cwd: input.workspace,
        title: input.title, sandbox_policy: '{"type":"workspace-write","writable_roots":[],"network_access":false,"exclude_tmpdir_env_var":false,"exclude_slash_tmp":false}',
        approval_mode: 'on-request', tokens_used: 0, has_user_event: 1, archived: 0, cli_version: cli, first_user_message: input.title,
        memory_mode: 'disabled', preview: input.title, recency_at: seconds, recency_at_ms: input.at, history_mode: 'paginated', is_pinned: 0,
        created_at_ms: input.at, updated_at_ms: input.at, thread_source: 'user', originator: 'codex_work_desktop',
      };
      if (columns.some(column => column.notnull && column.dflt_value == null && values[column.name] === undefined)) return 'Codex 会话索引未能更新。';
      const keys = Object.keys(values).filter(key => names.has(key));
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT INTO threads (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => values[key]));
        db.exec('COMMIT');
      } catch (error) {
        try {db.exec('ROLLBACK');} catch { /* The original index error is reported below. */ }
        throw error;
      }
      return;
    } finally {db.close();}
  } catch {
    return 'Codex 会话索引未能更新。';
  }
}

async function assertContained(file: string) {
  let current = resolve(file);
  const root = parsePath(current).root;
  while (current !== root) {
    try {if ((await lstat(current)).isSymbolicLink()) throw fail('路径经过符号链接，已停止，避免写到其他位置。');}
    catch (error) {if ((error as {statusCode?: number}).statusCode) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    current = dirname(current);
  }
}

async function writePrivate(file: string, body: string | Buffer) {
  await assertContained(file);
  await mkdir(dirname(file), {recursive: true, mode: 0o700});
  const temporary = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, body, {mode: 0o600, flag: 'wx'});
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
}

function compressZstd(text: string) {
  const compress = (zlib as Zstd).zstdCompressSync;
  if (!compress) throw fail('当前环境无法写入 DeepSeek 会话。');
  return compress(Buffer.from(text));
}

async function readCompressed(file: string, size: number, maxBytes: number, feed: LineFeed) {
  const create = (zlib as Zstd).createZstdDecompress;
  if (!create) throw fail('当前环境无法读取 DeepSeek 会话。');
  const handle = await open(file, 'r');
  const reader = new ByteSource(handle, size);
  try {
    let produced = 0;
    while (reader.position < size || reader.pending.length) {
      const magic = await reader.exact(4);
      if (!magic) break;
      const value = magic.readUInt32LE(0);
      if (value >= 0x184d2a50 && value <= 0x184d2a5f) {
        const length = await reader.exact(4);
        if (!length) throw fail('DeepSeek 会话无法读取。');
        await reader.discard(length.readUInt32LE(0));
        continue;
      }
      if (value !== ZSTD_MAGIC) break;
      const header = [magic];
      const descriptor = await reader.byte();
      header.push(Buffer.from([descriptor]));
      const sizeFlag = descriptor >> 6;
      const single = (descriptor & 0x20) !== 0;
      const checksum = (descriptor & 0x04) !== 0;
      const dictionary = descriptor & 0x03;
      if (!single) header.push(await reader.exact(1) ?? failRead());
      header.push(await reader.exact([0, 1, 2, 4][dictionary]) ?? failRead());
      const sizeBytes = sizeFlag === 0 ? (single ? 1 : 0) : sizeFlag === 1 ? 2 : sizeFlag === 2 ? 4 : 8;
      if (sizeBytes) header.push(await reader.exact(sizeBytes) ?? failRead());
      const decoder = create();
      let stopped = false;
      let settle: (error?: unknown) => void = () => {};
      const finished = new Promise<void>((resolve, reject) => {settle = error => error ? reject(error) : resolve();});
      decoder.on('end', () => settle());
      decoder.on('error', error => {if (!stopped) settle(error); else settle();});
      decoder.on('data', value => {
        const chunk = value as Buffer;
        if (produced >= maxBytes) {stopped = true; return;}
        const room = maxBytes - produced;
        const take = chunk.length > room ? chunk.subarray(0, room) : chunk;
        produced += take.length;
        pushChunk(feed, take, false);
        if (chunk.length > room) {feed.partial = true; stopped = true;}
      });
      const write = async (chunk: Buffer) => {
        if (stopped) return;
        if (decoder.write(chunk)) return;
        await new Promise<void>(resolve => decoder.once('drain', resolve));
      };
      await write(Buffer.concat(header));
      while (!stopped) {
        const block = await reader.exact(3);
        if (!block) throw fail('DeepSeek 会话无法读取。');
        await write(block);
        const blockHeader = block.readUIntLE(0, 3);
        const blockSize = (blockHeader >> 1) & 3;
        const bytes = blockHeader >> 3;
        if (blockSize === 3 || bytes > MAX_FRAME_BYTES) throw fail('DeepSeek 会话无法读取。');
        if (blockSize === 1) await write(await reader.exact(1) ?? failRead());
        else await reader.pipe(bytes, write);
        if (blockHeader & 1) break;
      }
      if (checksum && !stopped) await write(await reader.exact(4) ?? failRead());
      if (stopped) {stopped = true; decoder.destroy(); feed.partial = true; settle(); return;}
      decoder.end();
      try {await finished;} catch {throw fail('DeepSeek 会话无法读取。');}
    }
    pushChunk(feed, Buffer.alloc(0), true);
  } finally {await handle.close();}
}

function failRead(): never {throw fail('DeepSeek 会话无法读取。');}

class ByteSource {
  pending = Buffer.alloc(0);
  position = 0;
  constructor(private handle: Awaited<ReturnType<typeof open>>, private size: number) {}
  async exact(count: number) {
    if (!count) return Buffer.alloc(0);
    while (this.pending.length < count) {
      if (!(await this.pull())) return undefined;
    }
    const out = Buffer.from(this.pending.subarray(0, count));
    this.pending = Buffer.from(this.pending.subarray(count));
    return out;
  }
  async byte() {
    const found = await this.exact(1);
    if (!found) throw fail('DeepSeek 会话无法读取。');
    return found[0];
  }
  async discard(count: number) {
    let left = count;
    if (left > MAX_FRAME_BYTES) throw fail('DeepSeek 会话无法读取。');
    while (left) {
      if (this.pending.length) {
        const take = Math.min(this.pending.length, left);
        this.pending = Buffer.from(this.pending.subarray(take));
        left -= take;
        continue;
      }
      if (!(await this.pull())) throw fail('DeepSeek 会话无法读取。');
    }
  }
  async pipe(count: number, write: (chunk: Buffer) => Promise<void>) {
    if (count > MAX_FRAME_BYTES) throw fail('DeepSeek 会话无法读取。');
    let left = count;
    while (left) {
      if (!this.pending.length && !(await this.pull())) throw fail('DeepSeek 会话无法读取。');
      const take = Math.min(this.pending.length, left);
      await write(Buffer.from(this.pending.subarray(0, take)));
      this.pending = Buffer.from(this.pending.subarray(take));
      left -= take;
    }
  }
  private async pull() {
    if (this.position >= this.size) return false;
    const chunk = Buffer.alloc(Math.min(64 * 1024, this.size - this.position));
    const {bytesRead} = await this.handle.read(chunk, 0, chunk.length, this.position);
    if (!bytesRead) return false;
    this.position += bytesRead;
    this.pending = Buffer.concat([this.pending, chunk.subarray(0, bytesRead)]);
    return true;
  }
}
