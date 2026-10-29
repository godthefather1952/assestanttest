'use strict';
// Decodes pump bonding-curve events from transaction logs.
// Layouts come from idl/pump-events.json (a subset of the official IDL), not from hand-copied offsets.
// pump emits TradeEvent (and the other events used here) with Anchor's emit!, so each appears in the
// logs as "Program data: <base64>" while the pump program is executing.
const crypto = require('node:crypto');
const IDL = require('../idl/pump-events.json');

const PUMP_PROGRAM = IDL.address; // 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TYPES = Object.fromEntries(IDL.types.map((t) => [t.name, t]));
const BY_DISCRIMINATOR = new Map(IDL.events.map((e) => [Buffer.from(e.discriminator).toString('hex'), e.name]));

function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out = '1' + out;
  return out;
}

function base58Decode(text) {
  let n = 0n;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('Invalid base58');
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (let i = 0; i < text.length && text[i] === '1'; i++) bytes.unshift(0);
  return Buffer.from(bytes);
}

class Truncated extends Error {}

function defaultFor(type) {
  if (type === 'bool') return false;
  if (type === 'string') return '';
  if (type === 'pubkey') return '11111111111111111111111111111111';
  if (type === 'u64' || type === 'i64') return 0n;
  if (type === 'u8' || type === 'u16' || type === 'u32') return 0;
  if (type && type.vec) return [];
  if (type && type.defined) return decodeStruct(TYPES[type.defined.name], Buffer.alloc(0), { offset: 0 }, true);
  throw new Error('No default for type ' + JSON.stringify(type));
}

function need(buf, cursor, n) {
  if (cursor.offset + n > buf.length) throw new Truncated();
}

function readValue(type, buf, cursor) {
  switch (type) {
    case 'bool': need(buf, cursor, 1); return buf[cursor.offset++] !== 0;
    case 'u8': need(buf, cursor, 1); return buf[cursor.offset++];
    case 'u16': need(buf, cursor, 2); { const v = buf.readUInt16LE(cursor.offset); cursor.offset += 2; return v; }
    case 'u32': need(buf, cursor, 4); { const v = buf.readUInt32LE(cursor.offset); cursor.offset += 4; return v; }
    case 'u64': need(buf, cursor, 8); { const v = buf.readBigUInt64LE(cursor.offset); cursor.offset += 8; return v; }
    case 'i64': need(buf, cursor, 8); { const v = buf.readBigInt64LE(cursor.offset); cursor.offset += 8; return v; }
    case 'pubkey': need(buf, cursor, 32); { const v = base58(buf.subarray(cursor.offset, cursor.offset + 32)); cursor.offset += 32; return v; }
    case 'string': {
      need(buf, cursor, 4);
      const len = buf.readUInt32LE(cursor.offset);
      cursor.offset += 4;
      need(buf, cursor, len);
      const v = buf.toString('utf8', cursor.offset, cursor.offset + len);
      cursor.offset += len;
      return v;
    }
    default:
      if (type && type.vec) {
        need(buf, cursor, 4);
        const len = buf.readUInt32LE(cursor.offset);
        cursor.offset += 4;
        if (len > 1000) throw new Error('Vector too long');
        const out = [];
        for (let i = 0; i < len; i++) out.push(readValue(type.vec, buf, cursor));
        return out;
      }
      if (type && type.defined) return decodeStruct(TYPES[type.defined.name], buf, cursor, false);
      throw new Error('Unsupported type ' + JSON.stringify(type));
  }
}

// Reads fields in order. An event emitted by an older program version is shorter: when the data ends exactly at a field
// boundary, the remaining fields take their defaults (as the official SDK does). Data that ends inside a field is rejected.
function decodeStruct(def, buf, cursor, allDefaults) {
  if (!def) throw new Error('Unknown type');
  const out = {};
  let ended = allDefaults;
  for (const f of def.type.fields) {
    if (ended) { out[f.name] = defaultFor(f.type); continue; }
    if (cursor.offset === buf.length) { ended = true; out[f.name] = defaultFor(f.type); continue; }
    const start = cursor.offset;
    try {
      out[f.name] = readValue(f.type, buf, cursor);
    } catch (e) {
      if (e instanceof Truncated) throw new Error(`${def.name}: data ends inside field ${f.name} (offset ${start})`);
      throw e;
    }
  }
  return out;
}

function decodeEvent(data) {
  if (!Buffer.isBuffer(data) || data.length < 8) return null;
  const name = BY_DISCRIMINATOR.get(data.subarray(0, 8).toString('hex'));
  if (!name) return null;
  // Kept apart from the fields: CreateEvent has its own `name` field (the token name).
  return { type: name, data: decodeStruct(TYPES[name], data, { offset: 8 }, false) };
}

// Walks a transaction's log lines and returns the pump events, in order. "Program data:" lines count only while the pump
// program is the one executing (tracked from invoke/success/failed lines), so another program's data is never misread.
function parseLogs(logs) {
  const stack = [];
  const events = [];
  for (const line of logs || []) {
    if (typeof line !== 'string') continue;
    let m;
    if ((m = /^Program (\w+) invoke \[\d+\]$/.exec(line))) { stack.push(m[1]); continue; }
    if ((m = /^Program (\w+) (success|failed)/.exec(line))) {
      if (stack.length && stack[stack.length - 1] === m[1]) stack.pop();
      continue;
    }
    if (line.startsWith('Program data: ') && stack[stack.length - 1] === PUMP_PROGRAM) {
      let data;
      try { data = Buffer.from(line.slice(14), 'base64'); } catch (e) { continue; }
      try {
        const ev = decodeEvent(data);
        if (ev) events.push(ev);
      } catch (e) {
        events.push({ type: 'DecodeError', error: e.message });
      }
    }
  }
  return events;
}

function anchorDiscriminator(kind, name) {
  return crypto.createHash('sha256').update(`${kind}:${name}`).digest().subarray(0, 8);
}

module.exports = { PUMP_PROGRAM, base58, base58Decode, decodeEvent, parseLogs, anchorDiscriminator, IDL };
