import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  formatPercent,
  parseMoney,
  splitInstallments,
  sumCents,
  toCents,
} from '../src/domain/money';

describe('conversão para centavos', () => {
  it('converte reais sem erro de ponto flutuante', () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1)).toBe(10);
    expect(toCents(0.7)).toBe(70);
    expect(toCents(1234.56)).toBe(123456);
    expect(toCents(-45.9)).toBe(-4590);
  });

  it('soma centavos sem perder precisão', () => {
    // 0.1 + 0.2 !== 0.3 em float; em centavos é exato.
    expect(sumCents([10, 20])).toBe(30);
    const cents = Array.from({ length: 100 }, () => toCents(0.07));
    expect(sumCents(cents)).toBe(700);
  });
});

describe('leitura de valores digitados e de extrato', () => {
  it('entende o formato brasileiro', () => {
    expect(parseMoney('1.234,56')).toBe(123456);
    expect(parseMoney('R$ 1.234,56')).toBe(123456);
    expect(parseMoney('89,90')).toBe(8990);
    expect(parseMoney('1.000')).toBe(100000);
  });

  it('entende o formato americano dos arquivos OFX', () => {
    expect(parseMoney('1234.56')).toBe(123456);
    expect(parseMoney('1,234.56')).toBe(123456);
    expect(parseMoney('-45.90')).toBe(-4590);
  });

  it('entende sinais usados por bancos', () => {
    expect(parseMoney('(50,00)')).toBe(-5000);
    expect(parseMoney('50,00-')).toBe(-5000);
    expect(parseMoney('120,00 D')).toBe(-12000);
    expect(parseMoney('120,00 C')).toBe(12000);
  });

  it('devolve null quando não há número', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('saldo anterior')).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });
});

describe('divisão em parcelas', () => {
  it('divide exato quando não sobra centavo', () => {
    expect(splitInstallments(120_000, 6)).toEqual([20_000, 20_000, 20_000, 20_000, 20_000, 20_000]);
  });

  it('nunca perde nem cria centavos', () => {
    const parts = splitInstallments(10_000, 3);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(sumCents(parts)).toBe(10_000);
  });

  it('mantém a soma exata em qualquer combinação', () => {
    for (let total = 1; total <= 400; total++) {
      for (let n = 1; n <= 12; n++) {
        const parts = splitInstallments(total, n);
        expect(sumCents(parts)).toBe(total);
        expect(parts).toHaveLength(n);
        // Nenhuma parcela difere de outra em mais de 1 centavo.
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('recusa número de parcelas inválido', () => {
    expect(() => splitInstallments(1000, 0)).toThrow();
    expect(() => splitInstallments(1000, 1.5)).toThrow();
  });
});

describe('formatação', () => {
  it('formata em real brasileiro', () => {
    expect(formatMoney(123456).replace(/ /g, ' ')).toBe('R$ 1.234,56');
    expect(formatMoney(-4590).replace(/ /g, ' ')).toBe('-R$ 45,90');
    expect(formatMoney(0).replace(/ /g, ' ')).toBe('R$ 0,00');
  });

  it('formata percentual', () => {
    expect(formatPercent(0.423)).toBe('42,3%');
  });
});
