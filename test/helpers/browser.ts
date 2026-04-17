import CDP from 'chrome-remote-interface';

export interface BrowserSession {
  navigate(url: string): Promise<void>;
  clickBySelector(selector: string): Promise<void>;
  /**
   * Issues a click but returns as soon as Chrome has received the evaluate
   * request — does NOT await the JS execution. Use this when the click is
   * expected to hit a breakpoint: a regular awaited click would deadlock
   * because Runtime.evaluate only responds after execution finishes.
   */
  triggerClick(selector: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  close(): Promise<void>;
}

/**
 * Thin CDP-based page driver used by tests to trigger actions in the fixture
 * page (navigate, click a button). The debug-adapter under test uses its own
 * CDP connection on the same port — this test-side connection is separate so
 * the two can coexist.
 */
export async function connectTestBrowser(chromePort: number): Promise<BrowserSession> {
  const client = await CDP({ host: '127.0.0.1', port: chromePort });
  const { Page, Runtime, DOM } = client;
  await Promise.all([Page.enable(), Runtime.enable(), DOM.enable()]);

  return {
    async navigate(url: string) {
      await Page.navigate({ url });
      await Page.loadEventFired();
      // Give Vite's client + React a beat to hydrate before interactions.
      await new Promise((r) => setTimeout(r, 500));
    },
    async clickBySelector(selector: string) {
      const expr = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('selector not found: ' + ${JSON.stringify(selector)});
        el.click();
      })()`;
      const result = await Runtime.evaluate({ expression: expr, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(
          `click failed: ${result.exceptionDetails.text ?? ''} ` +
            `${result.exceptionDetails.exception?.description ?? ''}`.trim(),
        );
      }
    },
    async triggerClick(selector: string) {
      const expr = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('selector not found: ' + ${JSON.stringify(selector)});
        // setTimeout(0) decouples the click from the Runtime.evaluate call,
        // so evaluate returns immediately and the click fires independently
        // (and can pause the debugger without blocking us).
        setTimeout(() => el.click(), 0);
      })()`;
      const result = await Runtime.evaluate({ expression: expr });
      if (result.exceptionDetails) {
        throw new Error(
          `triggerClick failed: ${result.exceptionDetails.text ?? ''} ` +
            `${result.exceptionDetails.exception?.description ?? ''}`.trim(),
        );
      }
    },
    async textContent(selector: string) {
      const expr = `document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`;
      const { result } = await Runtime.evaluate({ expression: expr, returnByValue: true });
      return (result.value as string | null) ?? null;
    },
    async close() {
      await client.close();
    },
  };
}
