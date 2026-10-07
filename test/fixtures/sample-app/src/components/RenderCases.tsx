import React, { forwardRef, memo, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Props = { version: number };

function FunctionCase({ version }: Props): JSX.Element {
  const functionLabel = `function: ${version}`;
  return <span>{functionLabel}</span>;
}

const ArrowCase = ({ version }: Props): JSX.Element => {
  const arrowLabel = `arrow: ${version}`;
  return <span>{arrowLabel}</span>;
};

const MemoCase = memo(function MemoRender({ version }: Props): JSX.Element {
  const memoLabel = `memo: ${version}`;
  return <span>{memoLabel}</span>;
});

const RefCase = forwardRef<HTMLSpanElement, Props>(function RefRender({ version }, ref) {
  const refLabel = `ref: ${version}`;
  return <span ref={ref}>{refLabel}</span>;
});

class ClassCase extends React.Component<Props> {
  render(): JSX.Element {
    const classLabel = `class: ${this.props.version}`;
    return <span>{classLabel}</span>;
  }
}

function RenderCases(): JSX.Element {
  const [version, setVersion] = useState(0);
  return (
    <div>
      <button data-testid="render-cases-next" onClick={() => setVersion(version + 1)}>render</button>
      <FunctionCase version={version} />
      <ArrowCase version={version} />
      <MemoCase version={version} />
      <RefCase version={version} />
      <ClassCase version={version} />
    </div>
  );
}

export function mountRenderCases(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  createRoot(container).render(<RenderCases />);
}
