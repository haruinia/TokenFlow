import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {claudeKeychainService} from '../packages/core/src/claude-accounts.js';

const suffix=(value:string)=>`-${createHash('sha256').update(value.normalize('NFC')).digest('hex').slice(0,8)}`;
const defaultDir=join(homedir(),'.claude');

it('names the Claude Code keychain entry the same way as the CLI',()=>{
 expect(claudeKeychainService(defaultDir,{})).toBe('Claude Code-credentials');
 // The CLI hashes the variable exactly as written, including a trailing slash, even when it points at the default directory.
 expect(claudeKeychainService(defaultDir,{CLAUDE_CONFIG_DIR:defaultDir+'/'})).toBe('Claude Code-credentials'+suffix(defaultDir+'/'));
 expect(claudeKeychainService('/srv/claude',{CLAUDE_CONFIG_DIR:'/srv/claude/'})).toBe('Claude Code-credentials'+suffix('/srv/claude/'));
 expect(claudeKeychainService('/srv/claude',{CLAUDE_SECURESTORAGE_CONFIG_DIR:'',CLAUDE_CONFIG_DIR:'/srv/claude'})).toBe('Claude Code-credentials');
 expect(claudeKeychainService(defaultDir,{CLAUDE_SECURESTORAGE_CONFIG_DIR:'/vault'})).toBe('Claude Code-credentials'+suffix('/vault'));
 // Launched from Finder without the variable: a custom directory belongs to a CLI started with it set.
 expect(claudeKeychainService('/srv/claude',{})).toBe('Claude Code-credentials'+suffix('/srv/claude'));
});
