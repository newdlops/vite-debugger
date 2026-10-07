export function runPendingCase(): void {
  [1].forEach(() => {
    const pendingValue = 1;
    console.log(pendingValue);
  });
}
