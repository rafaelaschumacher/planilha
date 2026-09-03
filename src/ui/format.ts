import { formatMoney, type Cents, type FormatMoneyOptions } from '../domain/money';

/** Máscara do modo privacidade: esconde os valores sem mudar o leiaute. */
export const HIDDEN = '••••••';

export function money(cents: Cents, hide: boolean, options: FormatMoneyOptions = {}): string {
  return hide ? HIDDEN : formatMoney(cents, options);
}

/** Classe de cor por polaridade. Sempre acompanhada do sinal no texto. */
export function toneClass(cents: Cents): string {
  if (cents > 0) return 'text-in';
  if (cents < 0) return 'text-out';
  return 'text-ink-2';
}

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}
