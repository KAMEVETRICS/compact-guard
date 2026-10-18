// Types and calls for the local API in contracts/registry/deploy/server.mjs.

export type Attestation = {
  contractHash: string;
  label: string | null;
  path: string | null;
  errors: number;
  warnings: number;
  reviews: number;
  clean: boolean;
  attester: string;
  toolVersion: string;
  tool: string | null;
  reportCommitment: string;
  revealedReport: string | null;
  revealedSarif: string | null;
  txId: string | null;
  blockHeight: number | null;
};

export type Registry = {
  network: string;
  contractAddress: string;
  deployTx: string;
  deployBlock: number;
  attesterCount: number;
  totalAttestations: number;
  attestations: Attestation[];
  readAt: string;
};

export type Finding = {
  rule: string;
  title: string;
  severity: 'error' | 'warning' | 'review';
  line: number;
  column: number;
  circuit: string | null;
  message: string;
  docUrl: string;
};

export type ScanResult = {
  contractHash: string;
  findings: Finding[];
  syntaxErrors: { line: number; column: number; message: string }[];
  attestation: Attestation | null;
};

async function json<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const fetchRegistry = async (): Promise<Registry> => json(await fetch('/api/registry'));

export const scanSource = async (source: string): Promise<ScanResult> =>
  json(await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: source }));
