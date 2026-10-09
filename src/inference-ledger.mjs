import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX = Number.MAX_SAFE_INTEGER;
const dayMs = 86400000;
const failure = code => new Error(`JEFF_INFERENCE_${code}`);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/.test(value);
const amount = (value, zero = false) => Number.isSafeInteger(value) && value >= (zero ? 0 : 1);
function walletScope(scope) {
  const wallet = scope?.owner ?? scope?.wallet;
  if (!Number.isSafeInteger(scope?.chainId) || scope.chainId <= 0 || typeof wallet !== 'string'
    || !/^0x[a-fA-F0-9]{40}$/.test(wallet) || /^0x0{40}$/i.test(wallet)) throw failure('SCOPE_INVALID');
  return { chainId: scope.chainId, wallet: wallet.toLowerCase() };
}
function information(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('DETAILS_INVALID');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 4096) throw failure('DETAILS_INVALID');
  return encoded;
}

// Monetary values are integer millionths of one USD. Funding is an operator's
// attestation of settled provider capacity, never a blockchain or provider read.
// SQLite FULL commits protect process crashes. Restore reconciliation still
// requires an independent latest checkpoint; an old database cannot detect loss.
export function createInferenceLedger({ dataRoot, now = Date.now } = {}) {
  if (typeof dataRoot !== 'string' || !dataRoot || typeof now !== 'function') throw failure('CONFIG_INVALID');
  const root = resolve(dataRoot), directory = resolve(root, 'inference');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, 'ledger.sqlite');
  const newFile = !existsSync(file);
  const db = new DatabaseSync(file);
  try { chmodSync(file, 0o600); } catch (error) { if (process.platform !== 'win32') throw error; }
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
    db.exec(`
    CREATE TABLE IF NOT EXISTS inference_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inference_funding (
      id TEXT PRIMARY KEY, amount INTEGER NOT NULL CHECK(amount>0), created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS inference_grants (
      id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES inference_funding(id),
      chain_id INTEGER NOT NULL, wallet TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS inference_grants_wallet ON inference_grants(chain_id,wallet);
    CREATE INDEX IF NOT EXISTS inference_grants_receipt ON inference_grants(receipt_id);
    CREATE TABLE IF NOT EXISTS inference_calls (
      id TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, wallet TEXT NOT NULL,
      reserved INTEGER NOT NULL CHECK(reserved>0), charged INTEGER NOT NULL DEFAULT 0 CHECK(charged>=0 AND charged<=reserved),
      daily_limit INTEGER NOT NULL CHECK(daily_limit>0),
      state TEXT NOT NULL CHECK(state IN ('reserved','forwarded','unknown','charged','released')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, request_details TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS inference_calls_wallet ON inference_calls(chain_id,wallet);
    CREATE TABLE IF NOT EXISTS inference_reconciliations (
      evidence_id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES inference_calls(id),
      charged INTEGER NOT NULL CHECK(charged>=0), created_at INTEGER NOT NULL);`);
    const schema = db.prepare("SELECT value FROM inference_meta WHERE key='schema'").get()?.value;
    if (schema === undefined && newFile) db.exec("INSERT INTO inference_meta VALUES ('schema','1'), ('paused','false');");
    if (db.prepare("SELECT value FROM inference_meta WHERE key='schema'").get()?.value !== '1'
      || !['true','false'].includes(db.prepare("SELECT value FROM inference_meta WHERE key='paused'").get()?.value)) throw failure('STORAGE_UNAVAILABLE');
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* Initialization may fail before BEGIN. */ }
    db.close(); throw failure('STORAGE_UNAVAILABLE');
  }
  let closed = false;
  const time = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw failure('CLOCK_INVALID');
    return value;
  };
  const restoreBlocked = () => existsSync(resolve(root, 'hosting', 'restore-guard.json'))
    || existsSync(resolve(directory, 'restore-guard.json'));
  const paused = () => db.prepare("SELECT value FROM inference_meta WHERE key='paused'").get()?.value !== 'false';
  function allowed() {
    if (closed) throw failure('STORAGE_UNAVAILABLE');
    if (restoreBlocked()) throw failure('RESTORE_RECONCILIATION_REQUIRED');
    if (paused()) throw failure('PAUSED');
  }
  function transaction(operation) {
    if (closed) throw failure('STORAGE_UNAVAILABLE');
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const sum = (sql, ...args) => {
    const value = db.prepare(sql).get(...args)?.total ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) throw failure('STORAGE_UNAVAILABLE');
    return value;
  };
  const call = id => {
    if (!identifier(id)) throw failure('ID_INVALID');
    const row = db.prepare('SELECT * FROM inference_calls WHERE id=?').get(id);
    if (!row) throw failure('RESERVATION_NOT_FOUND');
    return row;
  };
  const describe = row => ({ id: row.id, chainId: row.chain_id, wallet: row.wallet,
    reservedMicros: row.reserved, chargedMicros: row.charged, dailyLimitMicros: row.daily_limit,
    state: row.state, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    details: JSON.parse(row.details) });
  function balance(scope) {
    const { chainId, wallet } = walletScope(scope);
    const grantedMicros = sum('SELECT COALESCE(SUM(amount),0) AS total FROM inference_grants WHERE chain_id=? AND wallet=?', chainId, wallet);
    const chargedMicros = sum('SELECT COALESCE(SUM(charged),0) AS total FROM inference_calls WHERE chain_id=? AND wallet=?', chainId, wallet);
    const heldMicros = sum("SELECT COALESCE(SUM(reserved),0) AS total FROM inference_calls WHERE chain_id=? AND wallet=? AND state IN ('reserved','forwarded','unknown')", chainId, wallet);
    if (chargedMicros + heldMicros > grantedMicros) throw failure('STORAGE_UNAVAILABLE');
    return { currency: 'USD', unit: 'microUSD', chainId, wallet, grantedMicros, chargedMicros, heldMicros,
      availableMicros: grantedMicros - chargedMicros - heldMicros, paused: paused(), restoreBlocked: restoreBlocked() };
  }
  function checkReservation({ scope, amountMicros, dailyLimitMicros, budgetScopeId } = {}) {
    const { chainId, wallet } = walletScope(scope);
    if (!amount(amountMicros) || !amount(dailyLimitMicros)
      || (budgetScopeId !== undefined && !/^[a-f0-9]{64}$/.test(budgetScopeId))) throw failure('RESERVATION_INVALID');
    allowed();
    const current = balance({ chainId, wallet });
    if (amountMicros > current.availableMicros) throw failure('BALANCE_EXHAUSTED');
    const dailySpent = sum(`SELECT COALESCE(SUM(CASE WHEN state IN ('reserved','forwarded','unknown') THEN reserved ELSE charged END),0) AS total
      FROM inference_calls WHERE chain_id=? AND wallet=? AND (state IN ('reserved','forwarded','unknown') OR updated_at>?)
      AND (? IS NULL OR json_extract(request_details,'$.budgetScopeId')=? OR json_extract(request_details,'$.budgetScopeId') IS NULL)`,
      chainId, wallet, time() - dayMs, budgetScopeId ?? null, budgetScopeId ?? null);
    if (amountMicros > dailyLimitMicros - dailySpent) throw failure('DAILY_LIMIT_REACHED');
    return { admitted: true, requiredMicros: amountMicros, availableMicros: current.availableMicros, dailyRemainingMicros: dailyLimitMicros - dailySpent };
  }
  function finalize(row, chargedMicros, details, at) {
    if (!amount(chargedMicros, true) || chargedMicros > row.reserved) throw failure('CHARGE_INVALID');
    const state = chargedMicros === 0 ? 'released' : 'charged';
    if (['charged','released'].includes(row.state)) {
      if (row.charged !== chargedMicros) throw failure('REPLAY_CONFLICT');
      return describe(row);
    }
    db.prepare('UPDATE inference_calls SET charged=?,state=?,details=?,updated_at=? WHERE id=?')
      .run(chargedMicros, state, information({ ...JSON.parse(row.details), ...details }), at, row.id);
    return describe(call(row.id));
  }
  return Object.freeze({
    file, balance, checkReservation,
    fund({ receiptId, amountMicros } = {}) {
      if (!identifier(receiptId) || !amount(amountMicros)) throw failure('FUNDING_INVALID');
      return transaction(() => {
        if (restoreBlocked()) throw failure('RESTORE_RECONCILIATION_REQUIRED');
        const existing = db.prepare('SELECT * FROM inference_funding WHERE id=?').get(receiptId);
        if (existing) { if (existing.amount !== amountMicros) throw failure('REPLAY_CONFLICT'); return { receiptId, amountMicros }; }
        const total = sum('SELECT COALESCE(SUM(amount),0) AS total FROM inference_funding');
        if (amountMicros > MAX - total) throw failure('AMOUNT_OVERFLOW');
        db.prepare('INSERT INTO inference_funding VALUES (?,?,?)').run(receiptId, amountMicros, time());
        return { receiptId, amountMicros };
      });
    },
    grant({ grantId, receiptId, chainId, wallet, amountMicros } = {}) {
      const scope = walletScope({ chainId, wallet });
      if (!identifier(grantId) || !identifier(receiptId) || !amount(amountMicros)) throw failure('GRANT_INVALID');
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM inference_grants WHERE id=?').get(grantId);
        if (existing) {
          if (existing.receipt_id !== receiptId || existing.chain_id !== chainId || existing.wallet !== scope.wallet || existing.amount !== amountMicros) throw failure('REPLAY_CONFLICT');
          return balance(scope);
        }
        allowed();
        const funding = db.prepare('SELECT amount FROM inference_funding WHERE id=?').get(receiptId);
        const assigned = sum('SELECT COALESCE(SUM(amount),0) AS total FROM inference_grants WHERE receipt_id=?', receiptId);
        if (!funding || amountMicros > funding.amount - assigned) throw failure('FUNDING_EXHAUSTED');
        db.prepare('INSERT INTO inference_grants VALUES (?,?,?,?,?,?)').run(grantId, receiptId, chainId, scope.wallet, amountMicros, time());
        return balance(scope);
      });
    },
    reserve({ id, scope, amountMicros, dailyLimitMicros, details = {}, budgetScopeId } = {}) {
      const { chainId, wallet } = walletScope(scope);
      if (!identifier(id) || !amount(amountMicros) || !amount(dailyLimitMicros)) throw failure('RESERVATION_INVALID');
      if (budgetScopeId !== undefined && !/^[a-f0-9]{64}$/.test(budgetScopeId)) throw failure('SCOPE_INVALID');
      if (Object.hasOwn(details, 'budgetScopeId') && details.budgetScopeId !== budgetScopeId) throw failure('SCOPE_INVALID');
      const encoded = information(budgetScopeId === undefined ? details : { ...details, budgetScopeId });
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM inference_calls WHERE id=?').get(id);
        if (existing) {
          if (existing.chain_id !== chainId || existing.wallet !== wallet || existing.reserved !== amountMicros || existing.daily_limit !== dailyLimitMicros
            || existing.request_details !== encoded) throw failure('REPLAY_CONFLICT');
          return describe(existing);
        }
        checkReservation({ scope: { chainId, wallet }, amountMicros, dailyLimitMicros, budgetScopeId });
        const at = time();
        db.prepare('INSERT INTO inference_calls VALUES (?,?,?,?,0,?,\'reserved\',?,?,?,?)')
          .run(id, chainId, wallet, amountMicros, dailyLimitMicros, at, at, encoded, encoded);
        return describe(call(id));
      });
    },
    markForwarded(id) {
      return transaction(() => {
        allowed(); const row = call(id);
        if (row.state !== 'reserved') throw failure('ALREADY_FORWARDED');
        db.prepare("UPDATE inference_calls SET state='forwarded',updated_at=? WHERE id=?").run(time(), id);
        return describe(call(id));
      });
    },
    settle({ id, chargedMicros, outcome = 'charged', details = {} } = {}) {
      return transaction(() => {
        const row = call(id);
        if (outcome === 'unknown') {
          if (['charged','released'].includes(row.state)) throw failure('REPLAY_CONFLICT');
          db.prepare("UPDATE inference_calls SET state='unknown',updated_at=?,details=? WHERE id=?")
            .run(time(), information({ ...JSON.parse(row.details), ...details }), id);
          return describe(call(id));
        }
        if (!['charged','no-charge'].includes(outcome) || (outcome === 'no-charge' && chargedMicros !== 0)) throw failure('OUTCOME_INVALID');
        if (row.state === 'reserved' && chargedMicros !== 0) throw failure('NOT_FORWARDED');
        return finalize(row, chargedMicros, details, time());
      });
    },
    release(id) {
      return transaction(() => {
        const row = call(id);
        if (row.state === 'released') return describe(row);
        if (row.state !== 'reserved') throw failure('RECONCILIATION_REQUIRED');
        return finalize(row, 0, { outcome: 'not-forwarded' }, time());
      });
    },
    reconcile({ id, chargedMicros, evidenceId } = {}) {
      if (!identifier(evidenceId) || !amount(chargedMicros, true)) throw failure('RECONCILIATION_INVALID');
      return transaction(() => {
        const row = call(id), previous = db.prepare('SELECT * FROM inference_reconciliations WHERE evidence_id=?').get(evidenceId);
        if (previous && (previous.call_id !== id || previous.charged !== chargedMicros)) throw failure('REPLAY_CONFLICT');
        const result = finalize(row, chargedMicros, { reconciliationEvidenceId: evidenceId }, time());
        if (!previous) db.prepare('INSERT INTO inference_reconciliations VALUES (?,?,?,?)').run(evidenceId, id, chargedMicros, time());
        return result;
      });
    },
    list(scope) {
      const { chainId, wallet } = walletScope(scope);
      const grants = db.prepare('SELECT * FROM inference_grants WHERE chain_id=? AND wallet=? ORDER BY created_at DESC LIMIT 200').all(chainId, wallet)
        .map(row => ({ type: 'grant', id: row.id, receiptId: row.receipt_id, amountMicros: row.amount, createdAt: new Date(row.created_at).toISOString() }));
      const calls = db.prepare('SELECT * FROM inference_calls WHERE chain_id=? AND wallet=? ORDER BY created_at DESC LIMIT 200').all(chainId, wallet)
        .map(row => ({ type: 'reservation', ...describe(row) }));
      return [...grants, ...calls].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
    },
    totals() {
      const fundedMicros = sum('SELECT COALESCE(SUM(amount),0) AS total FROM inference_funding');
      const grantedMicros = sum('SELECT COALESCE(SUM(amount),0) AS total FROM inference_grants');
      const chargedMicros = sum('SELECT COALESCE(SUM(charged),0) AS total FROM inference_calls');
      const heldMicros = sum("SELECT COALESCE(SUM(reserved),0) AS total FROM inference_calls WHERE state IN ('reserved','forwarded','unknown')");
      if (grantedMicros > fundedMicros || chargedMicros + heldMicros > grantedMicros) throw failure('STORAGE_UNAVAILABLE');
      return { currency: 'USD', unit: 'microUSD', fundedMicros, grantedMicros, chargedMicros, heldMicros,
        unallocatedMicros: fundedMicros - grantedMicros, outstandingMicros: grantedMicros - chargedMicros,
        paused: paused(), restoreBlocked: restoreBlocked() };
    },
    setPaused(value) {
      if (typeof value !== 'boolean') throw failure('CONFIG_INVALID');
      return transaction(() => { db.prepare("UPDATE inference_meta SET value=? WHERE key='paused'").run(String(value)); return { paused: value }; });
    },
    checkpoint() {
      if (closed) throw failure('STORAGE_UNAVAILABLE');
      const result = db.prepare('PRAGMA wal_checkpoint(FULL)').get();
      if (result?.busy) throw failure('CHECKPOINT_BUSY');
      return { checkpointed: true };
    },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}
