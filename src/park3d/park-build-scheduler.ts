/** Leave a paint opportunity between construction slices. Prioritized task
 * continuations alone can starve animation frames even with short tasks. */
export function yieldParkBuild(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });
}
