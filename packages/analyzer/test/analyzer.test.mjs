import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSource, analyzeDirectory } from '../dist/index.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const pre = 'pragma language_version 0.26; import CompactStandardLibrary;\n';
const analyze = source => analyzeSource(pre + source, 'test.compact');
const has = (result, rule) => result.findings.some(f => f.rule === rule);

test('ownPublicKey provenance survives helpers but ordinary use is not authorization', async () => {
  const result = await analyze('ledger owner: ZswapCoinPublicKey; circuit who(): ZswapCoinPublicKey { return ownPublicKey(); } export circuit change(): [] { assert(who() == owner, "auth"); }');
  assert.ok(has(result, 'CG001'));
  assert.ok(result.callGraph.change.includes('who'));
  assert.equal(has(await analyze('export circuit read(): ZswapCoinPublicKey { return ownPublicKey(); }'), 'CG001'), false);
});

test('low-domain provenance survives struct selection, helper calls and widening casts', async () => {
  const result = await analyze('struct Vote { choice: Boolean; salt: Bytes<32>; } witness vote(): Vote; pure circuit digest(x: Field): Bytes<32> { return persistentHash<Field>(x); } export circuit publish(): Bytes<32> { return disclose(digest(vote().choice as Field)); }');
  assert.ok(has(result, 'CG002'));
  assert.equal(has(await analyze('witness bit(): Boolean; witness salt(): Bytes<32>; export circuit publish(): Bytes<32> { return persistentCommit<Boolean>(bit(), salt()); }'), 'CG002'), false);
});

test('branches conservatively preserve taint, including branch predicates', async () => {
  const result = await analyze('witness bit(): Boolean; export circuit f(flag: Boolean): Bytes<32> { const x = false; if (flag) { x = bit(); } return disclose(persistentHash<Boolean>(x)); }');
  assert.ok(has(result, 'CG002'));
  assert.ok(has(await analyze('witness bit(): Boolean; export circuit f(): Bytes<32> { const x = bit() ? 1 : 0; return disclose(persistentHash<Field>(x)); }'), 'CG002'));
});

test('reused commitment randomizer is detected by value identity, not variable name', async () => {
  assert.ok(has(await analyze('witness seed(): Bytes<32>; export circuit f(a: Boolean,b: Boolean): [] { const r=seed(), alias=r; persistentCommit<Boolean>(a,r); persistentCommit<Boolean>(b,alias); }'), 'CG003'));
  assert.equal(has(await analyze('witness seed(): Bytes<32>; export circuit f(a: Boolean,b: Boolean): [] { persistentCommit<Boolean>(a,seed()); persistentCommit<Boolean>(b,seed()); }'), 'CG003'), false);
});

test('disclose and hashes do not erase witness provenance for map membership', async () => {
  assert.ok(has(await analyze('ledger m: Map<Bytes<32>,Boolean>; witness secret(): Bytes<32>; export circuit f(): Boolean { return m.member(disclose(persistentHash<Bytes<32>>(secret()))); }'), 'CG004'));
  assert.equal(has(await analyze('ledger m: Map<Field,Boolean>; export circuit f(): Boolean { return m.member(1); }'), 'CG004'), false);
});

test('Merkle binding requires an asserted equality on the same path leaf', async () => {
  const base = 'ledger tree: MerkleTree<8,Bytes<32>>; witness path(): MerkleTreePath<8,Bytes<32>>; witness secret(): Bytes<32>;';
  const body = 'const p=path(); const leaf=persistentHash<Vector<2,Bytes<32>>>([pad(32,"leaf"),secret()]);';
  assert.ok(has(await analyze(base + 'export circuit f(): [] {' + body + 'assert(tree.checkRoot(merkleTreePathRoot<8,Bytes<32>>(p)),"root");}'), 'CG005'));
  assert.equal(has(await analyze(base + 'export circuit f(): [] {' + body + 'assert(p.leaf == leaf,"leaf"); assert(tree.checkRoot(merkleTreePathRoot<8,Bytes<32>>(p)),"root");}'), 'CG005'), false);
  assert.ok(has(await analyze(base + 'export circuit f(): [] {' + body + 'assert(p.leaf != leaf,"wrong"); assert(tree.checkRoot(merkleTreePathRoot<8,Bytes<32>>(p)),"root");}'), 'CG005'));
});

test('domain separation is preserved through helper arguments; arbitrary constants do not qualify', async () => {
  const base='witness sk(): Bytes<32>;';
  assert.ok(has(await analyze(base+'export circuit f(): Bytes<32> { return persistentHash<Vector<2,Bytes<32>>>([default<Bytes<32>>,sk()]); }'), 'CG006'));
  assert.equal(has(await analyze(base+'pure circuit h(x: Vector<2,Bytes<32>>): Bytes<32> { return persistentHash<Vector<2,Bytes<32>>>(x); } export circuit f(): Bytes<32> { return h([pad(32,"app:pk"),sk()]); }'), 'CG006'), false);
});

test('aggregate disclosure is a review finding and scalar selection is not', async () => {
  const base='struct Profile {age: Uint<8>; secret: Bytes<32>;} witness profile(): Profile;';
  const result=await analyze(base+'export circuit f(): Profile { return disclose(profile()); }');
  assert.equal(result.findings.find(f=>f.rule==='CG007')?.severity,'review');
  assert.equal(has(await analyze(base+'export circuit f(): Uint<8> { return disclose(profile().age); }'),'CG007'),false);
});

test('one-time intent is explicit and a nullifier guard must check and insert the same key', async () => {
  const base='ledger used: Set<Bytes<32>>; witness secret(): Bytes<32>;\n// compact-guard: one-time claim\n';
  const key='const n=persistentHash<Vector<2,Bytes<32>>>([pad(32,"nullifier"),secret()]);';
  assert.ok(has(await analyze(base+'export circuit claim(): [] {'+key+'}'),'CG008'));
  assert.equal(has(await analyze(base+'export circuit claim(): [] {'+key+'assert(!used.member(disclose(n)),"used"); used.insert(disclose(n));}'),'CG008'),false);
  assert.ok(has(await analyze(base+'export circuit claim(): [] {'+key+'assert(used.member(disclose(n)),"wrong polarity"); used.insert(disclose(n));}'),'CG008'));
  assert.equal(has(await analyze('export circuit claim(): [] {}'),'CG008'),false);
});

test('syntax errors and unknown calls produce diagnostics rather than a clean result', async () => {
  const invalid=await analyze('ledger x: Field');
  assert.ok(invalid.diagnostics.some(d=>d.severity==='error'));
  const unknown=await analyze('export circuit f(): Field { return mystery(1); }');
  assert.ok(unknown.diagnostics.some(d=>d.code==='unresolved-call'));
});

test('shadowed names and branch-local bindings do not change unrelated provenance', async () => {
  assert.equal(has(await analyze('pure circuit ownPublicKey(): Boolean {return true;} export circuit f(): [] {assert(ownPublicKey(),"ok");}'),'CG001'),false);
  const result=await analyze('witness bit(): Boolean; export circuit f(flag:Boolean): Bytes<32> {const x=1; if(flag){const x=bit();} return persistentHash<Field>(x);}');
  assert.equal(has(result,'CG002'),false);
});

test('recursion is bounded and reported', async () => {
  const result=await analyze('circuit r(x: Field): Field { return r(x); } export circuit f(): Field { return r(1); }');
  assert.ok(result.diagnostics.some(d=>d.code==='recursive-call'));
});

test('all corpus pairs parse and distinguish their target rule', async () => {
  const base=new URL('../../../corpus/',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('manifest.json',base),'utf8'));
  assert.equal(manifest.cases.length,8);
  for(const c of manifest.cases) {
    for(const variant of ['vulnerable','fixed']) {
      const path=fileURLToPath(new URL(c[variant],base));
      const result=await analyzeSource(await readFile(path,'utf8'),path);
      assert.equal(result.diagnostics.filter(d=>d.severity==='error').length,0,`${c.id} ${variant}`);
      assert.equal(has(result,c.rule),variant==='vulnerable',`${c.id} ${variant}: ${JSON.stringify(result.findings)}`);
    }
  }
  const batch=await analyzeDirectory(fileURLToPath(base));
  assert.equal(batch.files.length,16);
});
