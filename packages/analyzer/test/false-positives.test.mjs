import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSource } from '../dist/index.js';
const pre='pragma language_version 0.23; import CompactStandardLibrary;\n';
const scan=source=>analyzeSource(pre+source,'entropy.compact');
const membership=result=>result.findings.filter(f=>f.rule==='CG004');

test('CG004 distinguishes raw and guessable keys from protected high-domain keys', async()=>{
  const cases=[
    ['witness sk():Bytes<32>;','sk()','Bytes<32>','warning'],
    ['witness bit():Boolean;','bit()','Boolean','warning'],
    ['witness bit():Boolean;','persistentHash<Boolean>(bit())','Bytes<32>','warning'],
    ['witness bit():Boolean;','persistentHash<Field>(bit() as Field)','Bytes<32>','warning'],
    ['witness sk():Bytes<32>;','persistentHash<Bytes<32>>(sk())','Bytes<32>',undefined],
    ['witness sk():Bytes<32>;','persistentHash<Uint<8>>(sk() as Uint<8>)','Bytes<32>','warning'],
    ['witness bit():Boolean; witness salt():Bytes<32>;','persistentCommit<Boolean>(bit(),salt())','Bytes<32>',undefined],
    ['witness bit():Boolean;','persistentCommit<Boolean>(bit(),default<Bytes<32>>)','Bytes<32>','warning'],
    ['witness sk():Bytes<32>; witness bit():Boolean;','[persistentHash<Bytes<32>>(sk()),bit()]','[Bytes<32>,Boolean]','warning'],
    ['witness bit():Boolean; ledger salt:Bytes<32>;','persistentHash<[Boolean,Bytes<32>]>([bit(),salt])','Bytes<32>','warning'],
  ];
  for(const [decl,key,type,severity] of cases){
    const r=await scan(`${decl} ledger keys:Set<${type}>; export circuit f():Boolean{return keys.member(disclose(${key}));}`);
    assert.deepEqual(r.diagnostics.filter(d=>d.severity==='error'),[],key);
    assert.deepEqual(membership(r).map(f=>f.severity),severity?[severity]:[],key);
  }
});

test('CG004 linkability requires the same protected derivation in multiple exported circuits',async()=>{
  const base='witness sk():Bytes<32>; ledger keys:Set<Bytes<32>>; circuit key():Bytes<32>{return persistentHash<Vector<2,Bytes<32>>>([pad(32,"id"),sk()]);} circuit query():Boolean{return keys.member(disclose(key()));}';
  const one=await scan(base+'export circuit first():Boolean{return query();}');
  assert.deepEqual(membership(one),[]);
  const two=await scan(base+'export circuit first():Boolean{return query();} export circuit second():Boolean{return query();}');
  assert.equal(membership(two).length,1);
  assert.equal(membership(two)[0].severity,'review');
  assert.match(membership(two)[0].message,/linkability/i);
  assert.match(membership(two)[0].evidence.detail,/first/);
  assert.match(membership(two)[0].evidence.detail,/second/);
  const different=await scan('witness sk():Bytes<32>; ledger keys:Set<Bytes<32>>; export circuit a():Boolean{return keys.member(persistentHash<Vector<2,Bytes<32>>>([pad(32,"a"),sk()]));} export circuit b():Boolean{return keys.member(persistentHash<Vector<2,Bytes<32>>>([pad(32,"b"),sk()]));}');
  assert.deepEqual(membership(different),[]);
});

test('findings deduplicate all helper entry paths and keep the strongest severity',async()=>{
  const r=await scan('witness bit():Boolean; witness sk():Bytes<32>; ledger keys:Set<Bytes<32>>; circuit h(x:Bytes<32>):Boolean{return keys.member(x);} circuit digest(x:Boolean):Bytes<32>{return persistentHash<Boolean>(x);} export circuit a():Boolean{return h(digest(bit()));} export circuit b():Boolean{return h(sk());} export circuit c():Bytes<32>{return digest(bit());}');
  const keys=r.findings.map(f=>JSON.stringify([f.rule,f.file,f.line,f.column]));
  assert.equal(new Set(keys).size,keys.length);
  const hash=r.findings.find(f=>f.rule==='CG006');
  assert.match(hash.evidence.detail,/a/);assert.match(hash.evidence.detail,/c/);
  assert.equal(membership(r)[0].severity,'warning');
});

test('explicit public argument disclosure is review, while disclosed raw witnesses still warn',async()=>{
  assert.equal(membership(await scan('ledger keys:Set<Uint<8>>; export circuit shot(x:Uint<8>):Boolean{return keys.member(disclose(x));}'))[0].severity,'review');
  assert.equal(membership(await scan('ledger keys:Set<Uint<8>>; witness x():Uint<8>; export circuit shot():Boolean{return keys.member(disclose(x()));}'))[0].severity,'warning');
});

test('CG004 does not invent entropy through selection, slicing or public salt',async()=>{
  const cases=[
    'witness bit():Boolean; ledger options:Vector<1,Field>; ledger keys:Set<Bytes<32>>; export circuit f():Boolean{const v=bit()?options:default<Vector<1,Field>>; return keys.member(disclose(persistentHash<Field>(v[0])));}',
    'witness bits():Vector<256,Boolean>; witness i():Uint<8>; ledger keys:Set<Bytes<32>>; export circuit f():Boolean{return keys.member(disclose(persistentHash<Boolean>(bits()[i()])));}',
    'witness bits():Vector<256,Boolean>; ledger keys:Set<Bytes<32>>; export circuit f():Boolean{return keys.member(disclose(persistentHash<Vector<1,Boolean>>(slice<1>(bits(),0))));}',
    'witness bit():Boolean; witness salt():Bytes<32>; ledger keys:Set<Bytes<32>>; export circuit f():Boolean{return keys.member(disclose(persistentHash<[Boolean,Bytes<32>]>([bit(),disclose(salt())])));}',
    'witness bit():Boolean; witness salt():Bytes<32>; ledger keys:Set<Bytes<32>>; export circuit f():Boolean{const r=salt(); disclose(r); return keys.member(disclose(persistentHash<[Boolean,Bytes<32>]>([bit(),r])));}',
  ];
  for(const source of cases){const r=await scan(source);assert.deepEqual(r.diagnostics.filter(d=>d.severity==='error'),[]);assert.equal(membership(r)[0]?.severity,'warning',source);}
});

test('conditional secret selection has a stable cross-entry derivation',async()=>{
  const r=await scan('witness b():Boolean; witness s1():Bytes<32>; witness s2():Bytes<32>; ledger keys:Set<Bytes<32>>; circuit query():Boolean{const x=b()?s1():s2();return keys.member(disclose(persistentHash<Bytes<32>>(x)));} export circuit a():Boolean{return query();} export circuit z():Boolean{return query();}');
  assert.equal(membership(r).length,1);assert.equal(membership(r)[0].severity,'review');assert.match(membership(r)[0].message,/a, z/);
});
