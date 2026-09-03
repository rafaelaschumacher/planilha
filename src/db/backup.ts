/**
 * Backup criptografado.
 *
 * O arquivo de backup contém a sua vida financeira inteira. Ele é cifrado com
 * AES-256-GCM usando uma chave derivada da SUA senha (PBKDF2-SHA256, 310 mil
 * iterações — a recomendação da OWASP).
 *
 * A senha NÃO é guardada em lugar nenhum. Se você perdê-la, o backup é
 * irrecuperável — nem por mim, nem por ninguém. Esse é exatamente o objetivo:
 * você pode guardar o arquivo no Drive, no e-mail ou num pendrive sem expor
 * nada.
 *
 * Tudo roda no navegador, com a WebCrypto nativa. Nenhum byte vai para a rede.
 */

import type { FinanceDataset } from '../domain/types';
import { emptyDataset } from '../domain/types';

const MAGIC = 'FINBKP1';
const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedBackup {
  magic: typeof MAGIC;
  createdAt: string;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  payload: string;
}

export interface PlainBackup {
  magic: 'FINBKP1-PLAIN';
  createdAt: string;
  data: FinanceDataset;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptBackup(data: FinanceDataset, password: string): Promise<EncryptedBackup> {
  if (!password || password.length < 8) {
    throw new Error('A senha do backup precisa ter pelo menos 8 caracteres.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);

  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext);

  return {
    magic: MAGIC,
    createdAt: new Date().toISOString(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
    cipher: { name: 'AES-GCM', iv: toBase64(iv) },
    payload: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptBackup(backup: EncryptedBackup, password: string): Promise<FinanceDataset> {
  if (backup?.magic !== MAGIC) {
    throw new Error('Arquivo não reconhecido como backup desta plataforma.');
  }
  const salt = fromBase64(backup.kdf.salt);
  const iv = fromBase64(backup.cipher.iv);
  const key = await deriveKey(password, salt, backup.kdf.iterations ?? PBKDF2_ITERATIONS);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      fromBase64(backup.payload) as BufferSource,
    );
  } catch {
    // AES-GCM autentica o conteúdo: falha aqui significa senha errada OU
    // arquivo adulterado. Nos dois casos, não há o que restaurar.
    throw new Error('Senha incorreta ou arquivo corrompido.');
  }

  return normalizeDataset(JSON.parse(new TextDecoder().decode(plaintext)));
}

export function buildPlainBackup(data: FinanceDataset): PlainBackup {
  return { magic: 'FINBKP1-PLAIN', createdAt: new Date().toISOString(), data };
}

/** Aceita tanto o backup criptografado quanto o aberto. */
export async function readBackupFile(text: string, password?: string): Promise<FinanceDataset> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('O arquivo não é um JSON válido.');
  }

  const candidate = parsed as { magic?: string; data?: unknown } | null;

  if (candidate?.magic === MAGIC) {
    if (!password) throw new Error('Este backup é criptografado. Informe a senha.');
    return decryptBackup(candidate as EncryptedBackup, password);
  }
  if (candidate?.magic === 'FINBKP1-PLAIN' && candidate.data) {
    return normalizeDataset(candidate.data as Partial<FinanceDataset>);
  }
  // Aceita também um JSON solto com o formato do conjunto de dados.
  if (candidate && typeof candidate === 'object' && 'transactions' in candidate) {
    return normalizeDataset(candidate as unknown as FinanceDataset);
  }
  throw new Error('Arquivo não reconhecido como backup desta plataforma.');
}

/**
 * Preenche o que estiver faltando e garante que o formato é o esperado.
 * Um backup antigo, ou editado à mão, não pode derrubar o app.
 */
export function normalizeDataset(input: Partial<FinanceDataset>): FinanceDataset {
  const base = emptyDataset();
  const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

  return {
    accounts: asArray(input.accounts),
    cards: asArray(input.cards),
    categories: asArray(input.categories),
    transactions: asArray(input.transactions),
    budgets: asArray(input.budgets),
    rules: asArray(input.rules),
    recurring: asArray(input.recurring),
    imports: asArray(input.imports),
    settings: { ...base.settings, ...(input.settings ?? {}), id: 'singleton' },
  };
}

/** Nome sugerido do arquivo: backup-financas-2024-03-15.fbk */
export function backupFileName(encrypted: boolean, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10);
  return `backup-financas-${stamp}.${encrypted ? 'fbk' : 'json'}`;
}
