import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validate,prediction,build,gate} from '../lanes/recipes/tray.js';
const request=(overrides={})=>({schema:'timmy.recipe-request/1',recipe:'enclosure.tray/1',parameters:{width:140,wall:3,supportOffset:10,bore:3,...overrides}});
describe('enclosure.tray/1 admission',()=>{
 it('refuses zero wall before a native process or prediction',()=>{
  const root=mkdtempSync(join(tmpdir(),'tray-refusal-'));writeFileSync(join(root,'package.json'),'{}');
  const r=build(request({wall:0}),{root,python:'/must-never-execute'});
  expect(r.state).toBe('refused');expect((r as any).nativeStarted).toBe(false);
  const chain=readFileSync(join(root,'.timmy/receipts/runs.jsonl'),'utf8');expect(chain).toContain('recipe.refused');expect(chain).not.toContain('recipe.prediction');
 });
 it.each([{wall:-1},{wall:NaN},{bore:12},{supportOffset:9},{supportOffset:35},{width:20},{bore:0},{width:'180'},{wall:Infinity}])('refuses unsafe parameters %j',p=>expect(()=>validate(request(p))).toThrow());
 it('rejects unsupported fields and unknown recipe',()=>{expect(()=>validate(request({script:'anything'}))).toThrow();expect(()=>validate({...request(),recipe:'arbitrary/1'})).toThrow();});
 it('predicts 20 mm outward displacement for matching support and bore axes',()=>{
  const a=prediction(validate(request())),b=prediction(validate(request({width:180})));
  expect(a.centers).toEqual([[-60,-30],[-60,30],[60,-30],[60,30]]);
  expect(b.centers).toEqual([[-80,-30],[-80,30],[80,-30],[80,30]]);
  expect(b.widthChange.mustMove).toEqual(['tray.bosses','tray.bores']);
  expect(b.widthChange.mustRebuild).toHaveLength(4);
 });
 it('fails closed on missing native gate results',()=>{
  expect(()=>gate({passed:true,checksTotal:30,variant:{checks:[]}},validate(request()),'/unused')).toThrow('30-check');
 });
});
