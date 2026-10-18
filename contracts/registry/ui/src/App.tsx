import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { fetchRegistry, scanSource, type Attestation, type Registry, type ScanResult } from './api.ts';

const short = (hex: string, n = 8) => `${hex.slice(0, n)}…${hex.slice(-6)}`;

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="copy" title="Copy" onClick={() => { void navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); }}>
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function Status({ a }: { a: Attestation | null }) {
  if (!a) return <span className="badge none">Not in registry</span>;
  return a.clean ? <span className="badge clean">Clean</span> : <span className="badge issues">Issues</span>;
}

function Counts({ a }: { a: { errors: number; warnings: number; reviews: number } }) {
  return (
    <span className="counts">
      <span className={a.errors ? 'n error' : 'n'}>{a.errors}</span>
      <span className={a.warnings ? 'n warning' : 'n'}>{a.warnings}</span>
      <span className={a.reviews ? 'n review' : 'n'}>{a.reviews}</span>
    </span>
  );
}

function ScanPanel({ onScanned }: { onScanned: () => void }) {
  const [source, setSource] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setError(null);
    try { setResult(await scanSource(source)); onScanned(); }
    catch (e) { setError((e as Error).message); setResult(null); }
    finally { setBusy(false); }
  };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) { setSource(await file.text()); setFileName(file.name); setResult(null); }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Check a contract</h2>
        <label className="file">
          Open .compact
          <input type="file" accept=".compact" onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) { setSource(await file.text()); setFileName(file.name); setResult(null); }
          }} />
        </label>
      </div>
      <textarea
        data-testid="source" spellCheck={false} value={source}
        placeholder="Paste Compact source or drop a .compact file"
        onChange={(e) => { setSource(e.target.value); setFileName(null); setResult(null); }}
        onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
      />
      <div className="actions">
        <span className="muted">{fileName ?? (source ? `${source.split('\n').length} lines` : '')}</span>
        <button className="primary" disabled={!source.trim() || busy} onClick={run}>{busy ? 'Scanning…' : 'Scan'}</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {result && (
        <div className="result" data-testid="result">
          <div className="onchain">
            <div>
              <div className="label">Source hash</div>
              <code>{short(result.contractHash, 16)}</code>
            </div>
            <div>
              <div className="label">On-chain attestation</div>
              <Status a={result.attestation} />
              {result.attestation && <span className="muted"> {result.attestation.label ?? ''}{result.attestation.tool ? ` · ${result.attestation.tool}` : ''}</span>}
            </div>
          </div>
          {result.syntaxErrors.length > 0 && (
            <ul className="findings">{result.syntaxErrors.map((s, i) => (
              <li key={i} className="finding error"><span className="sev">syntax</span><span className="where">{s.line}:{s.column}</span><span>{s.message}</span></li>
            ))}</ul>
          )}
          {result.findings.length === 0 && result.syntaxErrors.length === 0
            ? <p className="ok-text">No findings.</p>
            : (
              <ul className="findings">{result.findings.map((f, i) => (
                <li key={i} className={`finding ${f.severity}`}>
                  <span className="sev">{f.severity}</span>
                  <a className="rule" href={f.docUrl} target="_blank" rel="noreferrer">{f.rule}</a>
                  <span className="where">line {f.line}{f.circuit ? ` · ${f.circuit}` : ''}</span>
                  <span className="msg"><strong>{f.title}.</strong> {f.message}</span>
                </li>
              ))}</ul>
            )}
        </div>
      )}
    </section>
  );
}

function AttestationRow({ a }: { a: Attestation }) {
  return (
    <tr>
      <td>
        <div className="name">{a.label ?? 'Unlabelled contract'}</div>
        <code className="muted">{short(a.contractHash)}</code>
      </td>
      <td><Counts a={a} /></td>
      <td><Status a={a} /></td>
      <td>
        {a.revealedReport
          ? a.revealedSarif ? <a href={`/${a.revealedSarif}`} target="_blank" rel="noreferrer">Revealed</a> : 'Revealed'
          : <span className="muted" title={`Commitment ${a.reportCommitment}`}>Private</span>}
      </td>
      <td className="muted">{a.blockHeight ?? '—'}</td>
    </tr>
  );
}

export function App() {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { fetchRegistry().then(setRegistry, (e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);

  return (
    <div className="page">
      <header>
        <div className="brand">
          <span className="logo">◆</span>
          <div>
            <h1>compact-guard registry</h1>
            <div className="sub">Security scans of Compact contracts, recorded on Midnight</div>
          </div>
        </div>
        {registry && (
          <div className="meta">
            <span className="pill">Midnight {registry.network}</span>
            <span className="addr"><code>{short(registry.contractAddress, 12)}</code><Copy value={registry.contractAddress} /></span>
          </div>
        )}
      </header>

      {error && <p className="error-text">Could not read the registry: {error}</p>}

      <ScanPanel onScanned={load} />

      <section className="card">
        <div className="card-head">
          <h2>On-chain attestations</h2>
          {registry && (
            <span className="muted">
              {registry.attestations.length} contracts · {registry.attesterCount} attester{registry.attesterCount === 1 ? '' : 's'} · read {new Date(registry.readAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        {!registry ? <p className="muted">Reading the registry from the Preprod indexer…</p>
          : registry.attestations.length === 0 ? <p className="muted">No attestations yet.</p>
          : (
            <table>
              <thead><tr><th>Contract</th><th title="errors · warnings · reviews">E · W · R</th><th>Status</th><th>Report</th><th>Block</th></tr></thead>
              <tbody>{registry.attestations.map((a) => <AttestationRow key={a.contractHash} a={a} />)}</tbody>
            </table>
          )}
      </section>

      {registry && (
        <footer className="muted">
          Registry contract deployed at block {registry.deployBlock}. Look it up on{' '}
          <a href="https://preprod.midnightexplorer.com/" target="_blank" rel="noreferrer">Midnight Explorer</a> or{' '}
          <a href="https://midnight-preprod.subscan.io/" target="_blank" rel="noreferrer">Subscan</a>.
        </footer>
      )}
    </div>
  );
}
