import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  dayInMonth,
  dayOfWeek,
  diffMonths,
  endOfMonth,
  endOfWeek,
  formatMonthLong,
  lastMonths,
  monthOf,
  parseISO,
  startOfMonth,
  startOfWeek,
  today,
} from '../src/domain/dates';

describe('datas civis, sem fuso horário', () => {
  it('não desloca o dia por causa de fuso (bug clássico de mês errado)', () => {
    // `new Date('2024-03-01')` em UTC-3 exibiria 29/02. Aqui não.
    expect(monthOf('2024-03-01')).toBe('2024-03');
    expect(monthOf('2024-12-31')).toBe('2024-12');
    expect(monthOf('2024-01-01')).toBe('2024-01');
  });

  it('rejeita datas que não existem', () => {
    expect(parseISO('2024-02-30')).toBeNull();
    expect(parseISO('2023-02-29')).toBeNull();
    expect(parseISO('2024-13-01')).toBeNull();
    expect(parseISO('15/03/2024')).toBeNull();
    expect(parseISO('2024-02-29')).not.toBeNull(); // 2024 é bissexto
  });

  it('usa a data local para "hoje"', () => {
    const fixed = new Date(2024, 2, 31, 23, 30); // 31/03/2024 23:30 local
    expect(today(fixed)).toBe('2024-03-31');
  });
});

describe('soma de meses (base das parcelas)', () => {
  it('preserva o dia quando ele existe', () => {
    expect(addMonths('2024-03-15', 1)).toBe('2024-04-15');
    expect(addMonths('2024-03-15', 12)).toBe('2025-03-15');
  });

  it('ajusta para o último dia quando o dia não existe no mês', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29'); // bissexto
    expect(addMonths('2023-01-31', 1)).toBe('2023-02-28');
    expect(addMonths('2024-03-31', 1)).toBe('2024-04-30');
    expect(addMonths('2024-08-31', 6)).toBe('2025-02-28');
  });

  it('funciona para trás e atravessa o ano', () => {
    expect(addMonths('2024-01-15', -1)).toBe('2023-12-15');
    expect(addMonths('2024-01-15', -13)).toBe('2022-12-15');
  });

  it('conta a diferença entre meses', () => {
    expect(diffMonths('2024-06', '2024-03')).toBe(3);
    expect(diffMonths('2024-01', '2023-11')).toBe(2);
    expect(diffMonths('2023-11', '2024-01')).toBe(-2);
  });
});

describe('limites de mês', () => {
  it('acha o primeiro e o último dia', () => {
    expect(startOfMonth('2024-02')).toBe('2024-02-01');
    expect(endOfMonth('2024-02')).toBe('2024-02-29');
    expect(endOfMonth('2023-02')).toBe('2023-02-28');
    expect(endOfMonth('2024-04')).toBe('2024-04-30');
    expect(endOfMonth('2024-12')).toBe('2024-12-31');
  });

  it('encaixa dia de fechamento em meses curtos', () => {
    expect(dayInMonth('2024-02', 31)).toBe('2024-02-29');
    expect(dayInMonth('2024-04', 31)).toBe('2024-04-30');
    expect(dayInMonth('2024-04', 15)).toBe('2024-04-15');
  });

  it('lista os últimos meses em ordem', () => {
    expect(lastMonths('2024-03', 4)).toEqual(['2023-12', '2024-01', '2024-02', '2024-03']);
  });

  it('escreve o mês por extenso', () => {
    expect(formatMonthLong('2024-03')).toBe('março de 2024');
  });
});

describe('semanas', () => {
  it('sabe o dia da semana', () => {
    expect(dayOfWeek('2024-03-03')).toBe(0); // domingo
    expect(dayOfWeek('2024-03-04')).toBe(1); // segunda
    expect(dayOfWeek('2024-03-09')).toBe(6); // sábado
  });

  it('delimita a semana começando no domingo', () => {
    expect(startOfWeek('2024-03-06', 0)).toBe('2024-03-03');
    expect(endOfWeek('2024-03-06', 0)).toBe('2024-03-09');
  });

  it('delimita a semana começando na segunda', () => {
    expect(startOfWeek('2024-03-06', 1)).toBe('2024-03-04');
    expect(endOfWeek('2024-03-06', 1)).toBe('2024-03-10');
  });

  it('atravessa a virada de mês corretamente', () => {
    expect(startOfWeek('2024-03-01', 0)).toBe('2024-02-25');
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
  });
});
