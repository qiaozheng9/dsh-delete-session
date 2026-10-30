import test from 'node:test';
import assert from 'node:assert/strict';
import {titleText} from '../src/title.ts';

test('uses the actual title field of a released DSH SessionTitleSnapshot',()=>{
  assert.equal(titleText({title:'整理项目资料',messageSeqs:[1],source:{kind:'user'},eventSeq:4,updatedAt:1}),'整理项目资料');
});
test('accepts text titles and gives a readable fallback for absent or invalid snapshots',()=>{
  assert.equal(titleText('  对话标题  '),'对话标题');
  for(const value of [undefined,null,{},[],{title:{}},{title:'  '}])assert.equal(titleText(value),'未命名对话');
  assert.equal(titleText({},'菜单中的标题'),'菜单中的标题');
});
