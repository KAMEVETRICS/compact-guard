import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSource, parseSource } from '../dist/index.js';
const pre = 'pragma language_version 0.23; import CompactStandardLibrary;\n';
const scan = source => analyzeSource(pre + source, 'regression.compact');
const has = (result, rule) => result.findings.some(f => f.rule === rule);

test('owned IR retains repeated fields, module names, export lists and positions', async () => {
  const program = await parseSource('module M { circuit f(a: Field, b: Field): Field {return a;} export {f}; }\nexport circuit g(): [] {}', 'ir.compact');
  assert.deepEqual(program.diagnostics, []);
  assert.equal(program.circuits.get('M.f').params.length, 2);
  assert.equal(program.circuits.get('M.f').exported, true);
  assert.equal(program.circuits.get('g').node.span.line, 2);
  // A later parse cannot invalidate the copied nodes.
  await parseSource('ledger other: Field;');
  assert.equal(program.circuits.get('M.f').params[0].fields.name[0].text, 'a');
});

test('type aliases, enums, tuple destructuring and constructed structs retain small domains', async () => {
  for (const body of [
    'type Small = Uint<4>; witness x(): Small; export circuit f(): Bytes<32> {return persistentHash<Small>(x());}',
    'enum Choice { A, B, C } witness x(): Choice; export circuit f(): Bytes<32> {return persistentHash<Choice>(x());}',
    'witness bit(): Boolean; export circuit f(): Bytes<32> {const [x,y]=[bit(),1]; return persistentHash<Boolean>(x);}',
    'struct S {x:Boolean; y:Field;} witness bit(): Boolean; export circuit f(): Bytes<32> {const s=S {x:bit(),y:1}; return persistentHash<Boolean>(s.x);}',
    'witness bit(): Boolean; circuit g(): Field {if(bit()){return 1;}else{return 0;}} export circuit f(): Bytes<32> {return persistentHash<Field>(g());}',
  ]) { const r=await scan(body); assert.deepEqual(r.diagnostics.filter(d=>d.severity==='error'),[]); assert.ok(has(r,'CG002'),body); }
});

test('public ledger salt does not increase the private search space', async () => {
  const result = await scan('ledger publicSalt: Bytes<32>; witness bit(): Boolean; export circuit f(): Bytes<32> {return persistentHash<[Boolean,Bytes<32>]>([bit(),publicSalt]);}');
  assert.ok(has(result,'CG002'));
});

test('Merkle guards must dominate use, bind the same path, and assert equality', async () => {
  const base = 'ledger t: MerkleTree<8,Bytes<32>>; witness path(): MerkleTreePath<8,Bytes<32>>; witness secret(): Bytes<32>; export circuit f(flag:Boolean): [] {const p=path(), q=path(); const h=persistentHash<Vector<2,Bytes<32>>>([pad(32,"leaf"),secret()]);';
  const root = 'assert(t.checkRoot(merkleTreePathRoot<8,Bytes<32>>(p)),"root");';
  for (const body of [
    'assert(p.leaf==h || flag,"maybe");'+root,
    'assert(q.leaf==h,"other");'+root,
    root+'assert(p.leaf==h,"late");',
    'if(flag){assert(p.leaf==h,"conditional");}'+root,
    'flag && (assert(p.leaf==h,"short circuit"),true);'+root,
  ]) assert.ok(has(await scan(base+body+'}'),'CG005'),body);
  assert.equal(has(await scan(base+'assert(!(p.leaf!=h),"same");'+root+'}'),'CG005'),false);
});

test('replay recognition rejects mismatched keys, maps, ordering and conditional insertion', async () => {
  const base='ledger used:Set<Field>; ledger other:Set<Field>;\n// compact-guard: one-time f\nexport circuit f(n:Field,m:Field,flag:Boolean): [] {';
  for (const body of [
    'assert(!used.member(n),"new");used.insert(m);',
    'assert(!other.member(n),"new");used.insert(n);',
    'used.insert(n);assert(!used.member(n),"new");',
    'assert(!used.member(n),"new");if(flag){used.insert(n);}',
    'assert(!used.member(n)||flag,"maybe");used.insert(n);',
  ]) assert.ok(has(await scan(base+body+'}'),'CG008'),body);
  assert.equal(has(await scan(base+'assert(used.member(n)==false,"new");used.insert(n);'+'}'),'CG008'),false);
});

test('mutually exclusive commitments do not imply reuse', async () => {
  const r=await scan('witness salt():Bytes<32>; export circuit f(flag:Boolean): [] {const r=salt(); if(flag){persistentCommit<Boolean>(true,r);}else{persistentCommit<Boolean>(false,r);}}');
  assert.equal(has(r,'CG003'),false);
});

test('standard-library aliases and same-file module helpers resolve', async () => {
  const selected=await analyzeSource('import {persistentHash as h} from CompactStandardLibrary; witness bit():Boolean; export circuit f():Bytes<32>{return h<Boolean>(bit());}');
  assert.ok(has(selected,'CG002'));
  const prefixed=await analyzeSource('import CompactStandardLibrary prefix Lib_; witness bit():Boolean; export circuit f():Bytes<32>{return Lib_persistentHash<Boolean>(bit());}');
  assert.ok(has(prefixed,'CG002'));
  const module=await scan('module M {export pure circuit h(x:Boolean):Bytes<32>{return persistentHash<Boolean>(x);}} import M prefix M_; witness bit():Boolean; export circuit f():Bytes<32>{return M_h(bit());}');
  assert.ok(has(module,'CG002'));
  assert.ok(module.callGraph.f.includes('M.h'));
});

test('external imports expose analysis coverage and rule filters are exact', async () => {
  const result=await analyzeSource('import "missing"; export circuit f():Field{return remote();}');
  assert.ok(result.diagnostics.some(d=>d.code==='unresolved-import'));
  assert.ok(result.diagnostics.some(d=>d.code==='unresolved-call'));
  const filtered=await analyzeSource(pre+'witness bit():Boolean; export circuit f():Bytes<32>{return persistentHash<Boolean>(bit());}','filter.compact',{rules:['CG002']});
  assert.deepEqual(filtered.findings.map(f=>f.rule),['CG002']);
  assert.equal(filtered.findings[0].file,'filter.compact');
  assert.equal(filtered.findings[0].line,2);
  assert.equal(filtered.findings[0].evidence.kind,'static');
});

test('unknown ledger effects invalidate earlier nullifier facts', async () => {
  const result=await scan('ledger used:Set<Field>;\n// compact-guard: one-time f\nexport circuit f(n:Field): [] {assert(!used.member(n),"new");used.resetToDefault();used.insert(n);}');
  assert.ok(has(result,'CG008'));
  assert.ok(result.diagnostics.some(d=>d.code==='ledger-operation'));
});

test('module exports are helper visibility, not independent contract entry points', async () => {
  const result=await scan('module M {export pure circuit h(x:Vector<2,Bytes<32>>):Bytes<32>{return persistentHash<Vector<2,Bytes<32>>>(x);}} import M prefix M_; witness sk():Bytes<32>; export circuit f():Bytes<32>{return M_h([pad(32,"domain"),sk()]);}');
  assert.equal(has(result,'CG006'),false);
});

test('early-return authorization preserves the branch dependency on later writes', async () => {
  const result=await scan('ledger owner:ZswapCoinPublicKey; ledger value:Field; export circuit f(): [] {if(ownPublicKey()!=owner){return;} value=1;}');
  assert.ok(has(result,'CG001'));
});

test('selecting branch-derived aggregate members preserves control provenance', async () => {
  const result=await scan('witness bit():Boolean; export circuit f():Bytes<32>{const pair=bit()?[1,2]:[3,4];return persistentHash<Field>(pair[0]);}');
  assert.ok(has(result,'CG002'));
});

test('direct Merkle root assertions require leaf binding too', async () => {
  const base='ledger root:MerkleTreeDigest; witness path():MerkleTreePath<8,Bytes<32>>; witness secret():Bytes<32>; export circuit f():[] {const p=path();';
  const check='assert(merkleTreePathRoot<8,Bytes<32>>(p)==root,"root");}';
  assert.ok(has(await scan(base+check),'CG005'));
  assert.equal(has(await scan(base+'assert(p.leaf==persistentHash<Vector<2,Bytes<32>>>([pad(32,"leaf"),secret()]),"leaf");'+check),'CG005'),false);
});

test('helper-returned predicates retain their asserted meaning', async () => {
  const result=await scan('ledger used:Set<Field>; pure circuit invert(b:Boolean):Boolean{return !b;}\n// compact-guard: one-time f\nexport circuit f(n:Field): [] {assert(invert(used.member(n)),"new");used.insert(n);}');
  assert.equal(has(result,'CG008'),false);
});

test('module-local ledgers cannot satisfy each others nullifier checks', async () => {
  const result=await scan('module A {ledger used:Set<Field>; export circuit check(n:Field):[]{assert(!used.member(n),"new");}} module B {ledger used:Set<Field>; export circuit insert(n:Field):[]{used.insert(n);}} import A prefix A_; import B prefix B_;\n// compact-guard: one-time f\nexport circuit f(n:Field):[]{A_check(n);B_insert(n);}');
  assert.ok(has(result,'CG008'));
});
