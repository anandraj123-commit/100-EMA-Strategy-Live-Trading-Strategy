'use client';

import { useEffect, useRef } from 'react';
import view from '../lib/backtesting/reference-view.json';
import { mountReference } from '../lib/backtesting/reference-runtime';
import { createTransferGate, environmentDraft, researchDefaults, type SettingsValues, type ReadOptimizerResult, type OptimizerResult } from '../lib/backtesting/integration';

type Props = { portfolioId: string; symbol: string; saved: SettingsValues; onTransfer: (portfolioId: string, draft: SettingsValues) => void };

export default function BacktestingOptimisation(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const invalidate = useRef<(() => void) | null>(null);
  useEffect(() => { invalidate.current?.(); }, [props.saved]);
  useEffect(() => {
    if (!document.getElementById('backtesting-reference-fonts')) {
      const fonts = document.createElement('link');
      fonts.id = 'backtesting-reference-fonts'; fonts.rel = 'stylesheet';
      fonts.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap';
      document.head.append(fonts);
    }
    const surface = document.createElement('div');
    host.current!.replaceChildren(surface);
    const root = surface.attachShadow({ mode: 'open' });
    // Static, trusted reference markup. Shadow DOM preserves its CSS and scopes all IDs.
    root.innerHTML = `<style>:host{all:initial;display:block} ${view.css}</style><div class="reference-body">${view.body}</div>`;
    const input = (id: string) => root.getElementById(id) as HTMLInputElement;
    const button = document.createElement('button');
    button.textContent = 'Update Environment Variable';
    button.disabled = true;
    root.querySelector('.optimizer-actions')!.insertBefore(button, root.querySelector('.optimizer-actions .progress-outer'));
    const context = () => JSON.stringify([props.portfolioId, current.current.saved, Array.from(root.querySelectorAll('input'), el => [el.id, el.value])]);
    const gate = createTransferGate(props.portfolioId, context);
    let resolution = '';
    const refresh = () => {
      const result = gate.applicable(current.current.portfolioId);
      button.disabled = !result || !environmentDraft(result.params, resolution, current.current.saved);
    };
    const invalidateResult = () => { gate.invalidate(); refresh(); root.querySelectorAll('[aria-selected]').forEach(el => el.setAttribute('aria-selected', 'false')); };
    invalidate.current = invalidateResult;
    const bridge = {
      begin() { gate.begin(); resolution = input('resolution').value; refresh(); },
      ranked(read: ReadOptimizerResult) { gate.ranked(read); },
      complete(cancelled: boolean) {
        gate.complete(cancelled);
        root.querySelectorAll('#optimizerTableBody tr').forEach((row, index) => {
          row.setAttribute('tabindex', '0');
          row.setAttribute('aria-selected', String(index === 0 && !!gate.applicable(current.current.portfolioId)));
          row.setAttribute('aria-label', `Select optimization result ${index + 1}`);
          const select = () => {
            gate.select(index);
            root.querySelectorAll('#optimizerTableBody tr').forEach(el => el.setAttribute('aria-selected', String(el === row)));
            refresh();
          };
          row.addEventListener('click', select);
          row.addEventListener('keydown', event => { if (['Enter', ' '].includes((event as KeyboardEvent).key)) { event.preventDefault(); select(); } });
        });
        refresh();
      },
      applyingBest(best: OptimizerResult) {
        const finish = gate.applyingBest(current.current.portfolioId, best);
        return () => {
          finish();
          refresh();
          root.querySelectorAll('#optimizerTableBody tr').forEach((row, index) => {
            row.setAttribute('aria-selected', String(index === 0 && !!gate.applicable(current.current.portfolioId)));
          });
        };
      },
      invalidate: invalidateResult,
    };
    const runtime = mountReference(root, bridge, (url) => fetch(`/api/backtesting/candles?upstream=${encodeURIComponent(String(url))}`, { headers: { Accept: 'application/json' }, cache: 'no-store' }));
    for (const [id, value] of Object.entries(researchDefaults(props.saved, props.symbol))) input(id).value = value;
    const syncSymbolHeading = () => {
      const heading = root.querySelector('header h1');
      if (heading?.firstChild) heading.firstChild.textContent = runtime.readMarketInputs().symbol;
    };
    syncSymbolHeading();
    const onInput = () => { syncSymbolHeading(); invalidateResult(); };
    const selectionStyle = document.createElement('style');
    selectionStyle.textContent = '#optimizerTableBody tr[aria-selected="true"]{outline:1px solid var(--amber);outline-offset:-1px}';
    root.append(selectionStyle);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);
    button.addEventListener('click', () => {
      const selected = gate.applicable(current.current.portfolioId);
      if (!selected) return;
      const draft = environmentDraft(selected.params, resolution, current.current.saved);
      if (draft) current.current.onTransfer(props.portfolioId, draft);
    });
    return () => { runtime.dispose(); invalidate.current = null; root.removeEventListener('input', onInput); root.removeEventListener('change', onInput); surface.remove(); };
  }, [props.portfolioId]);
  return <div ref={host} aria-label="Backtesting & Optimisation" />;
}
