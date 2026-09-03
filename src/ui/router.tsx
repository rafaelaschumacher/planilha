/**
 * Roteador por hash (#/lancamentos).
 *
 * Hash em vez de History API porque o GitHub Pages devolve 404 para caminhos
 * que não existem como arquivo — com hash, recarregar a página em qualquer
 * tela continua funcionando, sem nenhuma configuração de servidor.
 */

import { useSyncExternalStore } from 'react';

function readHash(): string {
  const raw = window.location.hash.replace(/^#/, '');
  return raw || '/';
}

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

export interface Route {
  path: string;
  params: URLSearchParams;
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, readHash, () => '/');
  const [path, query = ''] = hash.split('?');
  return { path: path || '/', params: new URLSearchParams(query) };
}

export function navigate(to: string): void {
  const target = to.startsWith('#') ? to : `#${to}`;
  if (window.location.hash === target) return;
  window.location.hash = target;
  window.scrollTo({ top: 0 });
}

export function href(path: string): string {
  return `#${path}`;
}
