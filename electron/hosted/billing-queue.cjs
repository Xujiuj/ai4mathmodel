const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 200;
const MAX_REQUEST_IDS = 72;

function cleanRequestIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().slice(0, 160))
    .filter(Boolean))].slice(0, MAX_REQUEST_IDS);
}

function cleanPipelineId(value) {
  const pipelineId = String(value || '').trim().slice(0, 160);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(pipelineId) ? pipelineId : '';
}

function cleanOwner(owner = {}) {
  return {
    deviceId: String(owner.deviceId || '').trim().slice(0, 64),
    email: String(owner.email || '').trim().toLowerCase().slice(0, 160),
  };
}

function ownerKey(owner) {
  return crypto.createHash('sha256').update(JSON.stringify(cleanOwner(owner))).digest('hex');
}

function createPendingBillingQueue({ file, now = () => Date.now(), maxEntries = MAX_ENTRIES } = {}) {
  if (!file) throw new Error('PENDING_BILLING_FILE_REQUIRED');
  let operation = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      const entries = Array.isArray(raw?.entries) ? raw.entries : [];
      return entries.filter((entry) => cleanPipelineId(entry?.pipelineId)
        && cleanRequestIds(entry?.requestIds).length
        && typeof entry?.ownerKey === 'string')
        .map((entry) => ({
          id: String(entry.id || crypto.randomUUID()),
          ownerKey: String(entry.ownerKey),
          pipelineId: cleanPipelineId(entry.pipelineId),
          requestIds: cleanRequestIds(entry.requestIds),
          createdAt: Number(entry.createdAt) || now(),
          updatedAt: Number(entry.updatedAt) || now(),
          attempts: Math.max(0, Number(entry.attempts) || 0),
        }));
    } catch {
      return [];
    }
  }

  async function persist(entries) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(temporary, JSON.stringify({ version: SCHEMA_VERSION, entries }), { mode: 0o600 });
    await fsp.rename(temporary, file);
  }

  function enqueue(task) {
    operation = operation.then(task, task);
    return operation;
  }

  async function add({ owner, pipelineId, requestIds } = {}) {
    const normalizedOwner = cleanOwner(owner);
    const ownerId = ownerKey(normalizedOwner);
    const normalizedPipelineId = cleanPipelineId(pipelineId);
    const normalizedRequestIds = cleanRequestIds(requestIds);
    if (!normalizedPipelineId || !normalizedRequestIds.length || !normalizedOwner.deviceId) return false;
    return enqueue(async () => {
      const entries = await load();
      const existing = entries.find((entry) => entry.ownerKey === ownerId && entry.pipelineId === normalizedPipelineId);
      if (existing) {
        existing.requestIds = cleanRequestIds([...existing.requestIds, ...normalizedRequestIds]);
        existing.updatedAt = now();
      } else {
        entries.push({
          id: crypto.randomUUID(),
          ownerKey: ownerId,
          pipelineId: normalizedPipelineId,
          requestIds: normalizedRequestIds,
          createdAt: now(),
          updatedAt: now(),
          attempts: 0,
        });
      }
      entries.sort((a, b) => a.createdAt - b.createdAt);
      await persist(entries.slice(-Math.max(1, Number(maxEntries) || MAX_ENTRIES)));
      return true;
    });
  }

  async function flush({ owner, settle, limit = 8 } = {}) {
    if (typeof settle !== 'function') return { attempted: 0, settled: 0, pending: 0 };
    const ownerId = ownerKey(owner);
    return enqueue(async () => {
      const entries = await load();
      let attempted = 0;
      let settled = 0;
      const candidates = entries.filter((entry) => entry.ownerKey === ownerId).slice(0, Math.max(1, Number(limit) || 8));
      for (const entry of candidates) {
        attempted += 1;
        try {
          const result = await settle({ ...entry, requestIds: [...entry.requestIds] });
          if (result?.complete) {
            const index = entries.indexOf(entry);
            if (index >= 0) entries.splice(index, 1);
            settled += 1;
          } else {
            entry.requestIds = cleanRequestIds(result?.missingRequestIds?.length ? result.missingRequestIds : entry.requestIds);
            entry.updatedAt = now();
            entry.attempts += 1;
          }
        } catch {
          entry.updatedAt = now();
          entry.attempts += 1;
        }
      }
      if (attempted) await persist(entries);
      return { attempted, settled, pending: entries.filter((entry) => entry.ownerKey === ownerId).length };
    });
  }

  async function removeSettled({ owner, pipelineId, requestIds } = {}) {
    const ownerId = ownerKey(owner);
    const normalizedPipelineId = cleanPipelineId(pipelineId);
    const settledIds = new Set(cleanRequestIds(requestIds));
    if (!normalizedPipelineId || !settledIds.size) return false;
    return enqueue(async () => {
      const entries = await load();
      let changed = false;
      for (const entry of entries) {
        if (entry.ownerKey !== ownerId || entry.pipelineId !== normalizedPipelineId) continue;
        const remaining = entry.requestIds.filter((requestId) => !settledIds.has(requestId));
        if (remaining.length !== entry.requestIds.length) {
          changed = true;
          entry.requestIds = remaining;
          entry.updatedAt = now();
        }
      }
      const retained = entries.filter((entry) => entry.requestIds.length);
      if (changed) await persist(retained);
      return changed;
    });
  }

  async function entries() {
    return enqueue(load);
  }

  return { add, entries, flush, removeSettled };
}

module.exports = { cleanRequestIds, createPendingBillingQueue, ownerKey };
