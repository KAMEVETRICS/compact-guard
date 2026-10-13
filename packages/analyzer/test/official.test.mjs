import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { analyzeSource } from '../dist/index.js';

// Reviewed source locations in pinned local fixtures; never fetch at test time.
// Every retained item is a review, not a claim that these examples expose secrets.
const expected = {
  'example-bboard': [],
  'calculator': [],
  'token-transfers': [],
  'election': [
    ['CG004',89,13,'linkability'], // Shared voter identifier in registration, commit and reveal.
    ['CG004',129,12,'linkability'],
    ['CG004',131,13,'linkability'],
    ['CG004',165,12,'linkability'],
    ['CG004',167,12,'linkability'],
    ['CG004',181,12,'linkability'],
    ['CG006',253,21,'domain'], // Vote commitment hash has no domain prefix.
  ],
  'private-guest-list': [
    ['CG004',175,13,'disclosed circuit input'], // Guest's public identifier is explicitly disclosed.
  ],
  'private-reserve-auction': [
    ['CG006',175,18,'domain'], // Reserve-price hash has no domain prefix.
  ],
  'battleship-simple': [
    ['CG004',241,13,'disclosed circuit input'], // Player 1's intentionally public shot.
    ['CG004',285,13,'disclosed circuit input'], // Player 2's intentionally public shot.
    ['CG006',475,18,'domain'], // Board-space commitment hash has no domain prefix.
  ],
};

for (const [name, reviews] of Object.entries(expected)) test(`official ${name}: no warnings/errors and only reviewed findings`,async()=>{
  const file=fileURLToPath(new URL(`./fixtures/official/${name}.compact`,import.meta.url));
  const source=await readFile(file,'utf8');
  assert.ok(source.startsWith('pragma language_version 0.23;'));
  const result=await analyzeSource(source,file);
  assert.deepEqual(result.diagnostics.filter(d=>d.severity==='error'),[]);
  assert.deepEqual(result.findings.filter(f=>f.severity!=='review'),[]);
  assert.deepEqual(result.findings.map(f=>[f.rule,f.line,f.column]),reviews.map(([rule,line,column])=>[rule,line,column]));
  for(const [i,review] of reviews.entries()) assert.ok(result.findings[i].message.includes(review[3]));
  if(name==='battleship-simple') {
    const hash=result.findings.find(f=>f.rule==='CG006');
    for(const entry of ['<constructor>','acceptGame','checkBoard1','checkBoard2']) assert.ok(hash.evidence.detail.includes(entry));
  }
});
