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
      <CallbackRunner
        onRun={() => {
          const n = add(state.version, 1000);
          bump();
          void n;
        }}
      />
      <button
        data-testid="callback-arg"
        onClick={() => {
          runCallback(() => {
            const n = add(state.version, 2000);
            bump();
            void n;
          });
        }}
      >
        callback-arg
      </button>
      <button
        data-testid="function-expression"
        onClick={() => {
          const run = function () {
            const n = add(state.version, 3000);
            bump();
            void n;
          };
          run();
        }}
      >
        function-expression
      </button>
      <button
        data-testid="arrow-variable"
        onClick={() => {
          const run = () => {
            const n = add(state.version, 4000);
            bump();
            void n;
          };
          run();
        }}
      >
        arrow-variable
      </button>
    </div>
  );
}

function CallbackRunner(props: { onRun: () => void }): JSX.Element {
  return <button data-testid="component-prop" onClick={props.onRun}>component-prop</button>;
}

function runCallback(callback: () => void): void {
  callback();
}
