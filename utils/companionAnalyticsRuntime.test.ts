import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
it('desktop companions and calls do not report user behavior',()=>{
 for(const name of ['../apps/Appearance.tsx','../components/os/CompanionHome.tsx','../apps/CallApp.tsx']){
  const source=readFileSync(new URL(name,import.meta.url),'utf8');
  expect(source).not.toContain('trackEvent(');
 }
});
