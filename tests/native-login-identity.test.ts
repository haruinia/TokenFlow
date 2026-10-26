import {it,expect} from 'vitest';
import {desktopIdentityMatches as matches,officialLoginHeld,officialLoginSelected} from '../apps/shared/native-login-identity';
it.each(['workbuddy','workbuddy-ai','qoder'])('%s keeps its official identity selected while custom models are connected',provider=>{
 expect(officialLoginSelected(provider,true,true)).toBe(true);
 expect(officialLoginSelected(provider,true,false)).toBe(true);
 expect(officialLoginSelected(provider,false,true)).toBe(false);
});
it.each(['codex','claude'])('%s keeps official and gateway modes distinct',provider=>{
 expect(officialLoginSelected(provider,true,true)).toBe(false);
 expect(officialLoginSelected(provider,true,false)).toBe(true);
 expect(officialLoginHeld(provider,true,false)).toBe(false);
 expect(officialLoginHeld(provider,true,true)).toBe(true);
});
it('keeps a coexisting official login locked while gateway models stay imported',()=>{
 expect(officialLoginHeld('qoder',true,true)).toBe(true);
 expect(officialLoginHeld('qoder',true,false)).toBe(true);
 expect(officialLoginHeld('workbuddy',true,true)).toBe(true);
});
it('matches official domestic endpoint aliases without mixing international or enterprise logins',()=>{
 const native={accountId:'same-id',domain:'copilot.tencent.com',enterpriseId:'team'};
 for(const domain of ['www.codebuddy.cn','www.workbuddy.cn','https://copilot.tencent.com/'])expect(matches('workbuddy',native,{...native,domain})).toBe(true);
 expect(matches('workbuddy',native,{...native,domain:'www.workbuddy.ai'})).toBe(false);
 expect(matches('workbuddy-ai',native,native)).toBe(false);
 expect(matches('workbuddy',native,{...native,enterpriseId:'other-team'})).toBe(false);
 expect(matches('workbuddy',native,{...native,accountId:'other-id'})).toBe(false);
 expect(matches('workbuddy',native,{...native,domain:'unknown.test'})).toBe(false);
 expect(matches('workbuddy-ai',{...native,domain:'www.workbuddy.ai'},{...native,domain:'www.workbuddy.ai'})).toBe(true);
 expect(matches('qoder',{accountId:'qoder-id'},{accountId:'qoder-id'})).toBe(true);
 expect(matches('qoder',{},{accountId:'qoder-id'})).toBe(false);
});
it('keeps the matching Codex account selected only when the connection explicitly enables coexistence',()=>{
 expect(officialLoginSelected('codex',true,true,true)).toBe(true);
 expect(officialLoginSelected('codex',false,true,true)).toBe(false);
 expect(officialLoginHeld('codex',true,false,true)).toBe(true);
 expect(officialLoginSelected('codex',true,true,false)).toBe(false);
 expect(officialLoginHeld('codex',true,false,false)).toBe(false);
 expect(officialLoginSelected('claude',true,true,true)).toBe(false);
});
