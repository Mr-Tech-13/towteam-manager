export async function processWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const width = Math.max(1, Math.min(Number(concurrency) || 1, 10, queue.length || 1));
  const runners = Array.from({ length: width }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}
