// Legacy-Transaktionen bauen und serialisieren (Solana-Leitungsformat).
import { addressBytes, encodeBase58 } from './base58.js';
import { encodeCompactU16, concatBytes } from './bytes.js';

/** Größte erlaubte Transaktion in Byte. */
export const PACKET_DATA_SIZE = 1232;
const SIGNATURE_LENGTH = 64;
const MAX_ACCOUNT_KEYS = 256;

// Signer- und Schreibrechte gelten je Konto für die ganze Nachricht; der Zahler kommt zuerst.
function collectAccounts(feePayer, instructions) {
  const flags = new Map([[feePayer, { isSigner: true, isWritable: true }]]);
  const merge = (pubkey, isSigner, isWritable) => {
    const prev = flags.get(pubkey);
    flags.set(
      pubkey,
      prev ? { isSigner: prev.isSigner || isSigner, isWritable: prev.isWritable || isWritable } : { isSigner, isWritable },
    );
  };
  for (const ix of instructions) {
    for (const key of ix.keys) merge(key.pubkey, key.isSigner, key.isWritable);
    merge(ix.programId, false, false);
  }
  return [...flags.entries()];
}

export function compileLegacyMessage({ feePayer, recentBlockhash, instructions }) {
  if (!Array.isArray(instructions) || instructions.length === 0) throw new Error('No instructions for this transaction');
  addressBytes(feePayer);
  addressBytes(recentBlockhash);
  const entries = collectAccounts(feePayer, instructions);
  const pick = (signer, writable) =>
    entries.filter(([, f]) => f.isSigner === signer && f.isWritable === writable).map(([key]) => key);
  const signedWritable = pick(true, true);
  const signedReadonly = pick(true, false);
  const unsignedWritable = pick(false, true);
  const unsignedReadonly = pick(false, false);
  const accountKeys = [...signedWritable, ...signedReadonly, ...unsignedWritable, ...unsignedReadonly];
  if (accountKeys.length > MAX_ACCOUNT_KEYS) throw new Error('Too many accounts for one transaction');
  const index = new Map(accountKeys.map((key, i) => [key, i]));
  return {
    header: {
      numRequiredSignatures: signedWritable.length + signedReadonly.length,
      numReadonlySignedAccounts: signedReadonly.length,
      numReadonlyUnsignedAccounts: unsignedReadonly.length,
    },
    accountKeys,
    recentBlockhash,
    instructions: instructions.map((ix) => ({
      programIdIndex: index.get(ix.programId),
      accountIndexes: ix.keys.map((key) => index.get(key.pubkey)),
      data: ix.data,
    })),
  };
}

export function serializeMessage(message) {
  const { header } = message;
  const parts = [
    Uint8Array.of(header.numRequiredSignatures, header.numReadonlySignedAccounts, header.numReadonlyUnsignedAccounts),
    Uint8Array.from(encodeCompactU16(message.accountKeys.length)),
    ...message.accountKeys.map(addressBytes),
    addressBytes(message.recentBlockhash),
    Uint8Array.from(encodeCompactU16(message.instructions.length)),
  ];
  for (const ix of message.instructions) {
    parts.push(
      Uint8Array.of(ix.programIdIndex),
      Uint8Array.from(encodeCompactU16(ix.accountIndexes.length)),
      Uint8Array.from(ix.accountIndexes),
      Uint8Array.from(encodeCompactU16(ix.data.length)),
      ix.data,
    );
  }
  return concatBytes(parts);
}

/** Unsignierte Transaktion: leere Signaturplätze, dann die Nachricht. */
export function buildUnsignedTransaction({ feePayer, recentBlockhash, instructions }) {
  const message = compileLegacyMessage({ feePayer, recentBlockhash, instructions });
  const messageBytes = serializeMessage(message);
  const count = message.header.numRequiredSignatures;
  const bytes = concatBytes([
    Uint8Array.from(encodeCompactU16(count)),
    new Uint8Array(count * SIGNATURE_LENGTH),
    messageBytes,
  ]);
  return { message, messageBytes, bytes, size: bytes.length };
}

/**
 * Liest eine Legacy-Nachricht zurück (z. B. die, die eine Wallet unterschrieben hat).
 * Signer- und Schreibrechte ergeben sich aus dem Kopf, wie bei der Laufzeit.
 */
export function decompileLegacyMessage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 3) throw new Error('Transaction message is too short');
  if (bytes[0] & 0x80) throw new Error('Unsupported transaction version. Only legacy is supported');
  let offset = 0;
  const need = (n) => {
    if (offset + n > bytes.length) throw new Error('Transaction message is incomplete');
  };
  const readU8 = () => {
    need(1);
    offset += 1;
    return bytes[offset - 1];
  };
  const readCompact = () => {
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const byte = readU8();
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('Invalid compact-u16');
  };
  const readBytes = (n) => {
    need(n);
    offset += n;
    return bytes.slice(offset - n, offset);
  };
  const header = { numRequiredSignatures: readU8(), numReadonlySignedAccounts: readU8(), numReadonlyUnsignedAccounts: readU8() };
  const accountKeys = Array.from({ length: readCompact() }, () => encodeBase58(readBytes(32)));
  const recentBlockhash = encodeBase58(readBytes(32));
  const signers = header.numRequiredSignatures;
  const isWritable = (i) => (i < signers ? i < signers - header.numReadonlySignedAccounts : i < accountKeys.length - header.numReadonlyUnsignedAccounts);
  const instructions = Array.from({ length: readCompact() }, () => {
    const programIdIndex = readU8();
    const indexes = Array.from({ length: readCompact() }, () => readU8());
    const data = readBytes(readCompact());
    if (programIdIndex >= accountKeys.length || indexes.some((i) => i >= accountKeys.length)) throw new Error('Account index is out of range');
    return {
      programId: accountKeys[programIdIndex],
      keys: indexes.map((i) => ({ pubkey: accountKeys[i], isSigner: i < signers, isWritable: isWritable(i) })),
      data,
    };
  });
  if (offset !== bytes.length) throw new Error('Transaction message has extra bytes');
  return { header, accountKeys, recentBlockhash, instructions };
}

function firstSignatureBytes(wire) {
  if (!(wire instanceof Uint8Array) || wire.length < 1 + SIGNATURE_LENGTH || wire[0] < 1 || wire[0] > 0x7f) {
    throw new Error('No signature in this transaction');
  }
  return wire.subarray(1, 1 + SIGNATURE_LENGTH);
}

/** Die Signatur des Zahlers (zugleich die Transaktions-ID) als Base58. */
export function readFirstSignature(wire) {
  return encodeBase58(firstSignatureBytes(wire));
}

/** true, wenn die Wallet den ersten Signaturplatz wirklich gefüllt hat. */
export function hasSignature(wire) {
  try {
    return firstSignatureBytes(wire).some((byte) => byte !== 0);
  } catch {
    return false;
  }
}
