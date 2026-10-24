import {expect,it} from 'vitest';
import {codexRoutingMode} from '../packages/core/src/codex-routing-mode';

it.each([null,'','model="gpt-6-astra"','model_provider="openai"\n[otel]\nlog_user_prompt=false'])('recognizes native official configuration: %s',config=>{
 expect(codexRoutingMode(config)).toBe('official');
});
it.each([['/v1','gateway'],['/codex/v1','coexist']])('distinguishes %s without relying on login state', (path,mode)=>{
 expect(codexRoutingMode(`model_provider="token_flow"\n[model_providers.token_flow]\nbase_url="http://127.0.0.1:9527${path}"`)).toBe(mode);
});
it('uses the active profile and rejects overridden official endpoints',()=>{
 expect(codexRoutingMode('model_provider="token_flow"\nprofile="work"\n[profiles.work]\nmodel_provider="openai"')).toBe('official');
 expect(codexRoutingMode('profile="work"\n[profiles.work]\nmodel_provider="custom"')).toBe('external');
 expect(codexRoutingMode('openai_base_url="http://127.0.0.1:9527/v1"')).toBe('external');
 expect(codexRoutingMode('[model_providers.openai]\nbase_url="https://example.test"')).toBe('external');
 expect(codexRoutingMode('profile="work"\n[model_providers.openai]\nbase_url="https://example.test"\n[profiles.work.model_providers.openai]')).toBe('external');
 expect(codexRoutingMode('model_provider="token_flow"\n[model_providers.token_flow]\nbase_url="https://example.test/v1"')).toBe('external');
 expect(codexRoutingMode('profile="missing"')).toBe('unreadable');
 expect(codexRoutingMode('broken=[')).toBe('unreadable');
});
