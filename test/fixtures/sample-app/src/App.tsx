import React from 'react';
import { add } from './math';
import { useCanonicalData } from './hooks/useCanonicalData';

export function App(): JSX.Element {
  const { state, bump } = useCanonicalData();

  function handleClick(): void {
    const next = add(state.version, 1);
    bump();
    void next;
  }

  return (
    <div>
      <h1>Fixture app</h1>
      <p data-testid="count">count: {state.version}</p>
      <button data-testid="inc" onClick={handleClick}>increment</button>
      <button data-testid="lambda-one" onClick={() => { const n = add(state.version, 10); bump(); void n; }}>one-line-lambda</button>
      <button
        data-testid="lambda-multi"
        onClick={() => {
          const n = add(state.version, 100);
          bump();
          void n;
        }}
      >
        multi-line-lambda
      </button>
    </div>
  );
}
