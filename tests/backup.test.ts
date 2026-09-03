import { describe, expect, it } from 'vitest';
import { backupFileName, buildPlainBackup, encryptBackup, readBackupFile } from '../src/db/backup';
import { buildDemoDataset } from '../src/db/demo';

const data = buildDemoDataset({ endMonth: '2024-06', months: 3, today: '2024-06-18' });

describe('backup criptografado', () => {
  it('vai e volta sem perder nada', async () => {
    const backup = await encryptBackup(data, 'minha-senha-forte');
    const restored = await readBackupFile(JSON.stringify(backup), 'minha-senha-forte');
    expect(restored.transactions).toHaveLength(data.transactions.length);
    expect(restored.accounts).toEqual(data.accounts);
    expect(restored.settings.firstDayOfWeek).toBe(data.settings.firstDayOfWeek);
  });

  it('o arquivo não contém nada legível', async () => {
    const backup = await encryptBackup(data, 'minha-senha-forte');
    const texto = JSON.stringify(backup);
    expect(texto).not.toContain('Aluguel');
    expect(texto).not.toContain('NETFLIX');
    expect(texto).not.toContain('Conta corrente');
  });

  it('senha errada não abre o arquivo', async () => {
    const backup = await encryptBackup(data, 'minha-senha-forte');
    await expect(readBackupFile(JSON.stringify(backup), 'senha-errada')).rejects.toThrow(/Senha incorreta/);
  });

  it('arquivo adulterado é rejeitado', async () => {
    const backup = await encryptBackup(data, 'minha-senha-forte');
    // Troca o primeiro caractere por um DIFERENTE. Fixar a letra faria o teste
    // falhar de vez em quando, justamente quando ela já fosse a original.
    const primeiro = backup.payload[0];
    backup.payload = `${primeiro === 'A' ? 'B' : 'A'}${backup.payload.slice(1)}`;
    await expect(readBackupFile(JSON.stringify(backup), 'minha-senha-forte')).rejects.toThrow(
      /Senha incorreta ou arquivo corrompido/,
    );
  });

  it('exige senha com tamanho mínimo', async () => {
    await expect(encryptBackup(data, 'curta')).rejects.toThrow(/pelo menos 8/);
  });

  it('pede a senha quando o arquivo é criptografado', async () => {
    const backup = await encryptBackup(data, 'minha-senha-forte');
    await expect(readBackupFile(JSON.stringify(backup))).rejects.toThrow(/Informe a senha/);
  });

  it('cada backup usa sal e vetor novos', async () => {
    const a = await encryptBackup(data, 'minha-senha-forte');
    const b = await encryptBackup(data, 'minha-senha-forte');
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.payload).not.toBe(b.payload);
  });
});

describe('backup aberto e arquivos estranhos', () => {
  it('lê o backup sem criptografia', async () => {
    const restored = await readBackupFile(JSON.stringify(buildPlainBackup(data)));
    expect(restored.transactions).toHaveLength(data.transactions.length);
  });

  it('recusa arquivo que não é backup', async () => {
    await expect(readBackupFile('não é json')).rejects.toThrow(/JSON válido/);
    await expect(readBackupFile('{"qualquer":1}')).rejects.toThrow(/não reconhecido/);
  });

  it('completa campos ausentes em backup antigo', async () => {
    const restored = await readBackupFile('{"transactions":[],"accounts":[]}');
    expect(restored.categories).toEqual([]);
    expect(restored.settings.id).toBe('singleton');
    expect(restored.settings.commitmentHorizonMonths).toBe(12);
  });

  it('sugere um nome de arquivo com a data', () => {
    expect(backupFileName(true, new Date('2024-03-15T10:00:00Z'))).toBe('backup-financas-2024-03-15.fbk');
    expect(backupFileName(false, new Date('2024-03-15T10:00:00Z'))).toBe('backup-financas-2024-03-15.json');
  });
});
