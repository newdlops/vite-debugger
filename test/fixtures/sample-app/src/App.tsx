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
    </div>
  );
}
