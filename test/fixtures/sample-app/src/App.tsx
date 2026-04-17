import React, { useState } from 'react';
import { add } from './math';

export function App(): JSX.Element {
  const [count, setCount] = useState(0);

  function handleClick(): void {
    const next = add(count, 1);
    setCount(next);
  }

  return (
    <div>
      <h1>Fixture app</h1>
      <p data-testid="count">count: {count}</p>
      <button data-testid="inc" onClick={handleClick}>increment</button>
    </div>
  );
}
