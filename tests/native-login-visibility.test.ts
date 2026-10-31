import {expect,it} from 'vitest';
import {hasNativeLogin} from '../apps/console/src/native-login-visibility';

it('hides local login while loading or signed out, regardless of saved gateway accounts',()=>{
 expect(hasNativeLogin(undefined)).toBe(false);
 expect(hasNativeLogin({})).toBe(false);
 expect(hasNativeLogin({status:{email:''}})).toBe(false);
 expect(hasNativeLogin({status:{loginState:'signed-out',email:'stale@example.test'}})).toBe(false);
 expect(hasNativeLogin({status:{loginState:'not-inspected',email:'stale@example.test'}})).toBe(false);
});
it('does not present unreadable credentials as a confirmed local login',()=>{
 expect(hasNativeLogin({status:{loginState:'unreadable',email:'stale@example.test'}})).toBe(false);
 expect(hasNativeLogin({status:{readError:'unreadable',email:'stale@example.test'}})).toBe(false);
 expect(hasNativeLogin({status:{email:'stale@example.test'},error:'read failed'})).toBe(false);
});
it('shows confirmed local identities, including accounts not saved in the gateway',()=>{
 expect(hasNativeLogin({status:{loginState:'signed-in'}})).toBe(true);
 expect(hasNativeLogin({status:{email:'local@example.test'}})).toBe(true);
 expect(hasNativeLogin({status:{email:'  '}})).toBe(false);
});
it('hides the panel again after logout and shows it after the next login refresh',()=>{
 const signedIn={status:{email:'local@example.test'}};
 expect(hasNativeLogin(signedIn)).toBe(true);
 expect(hasNativeLogin({status:{loginState:'signed-out',email:''}})).toBe(false);
 expect(hasNativeLogin(signedIn)).toBe(true);
});
