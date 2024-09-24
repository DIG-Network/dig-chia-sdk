
/**
 * Processes items in sequential batches with a concurrency limit.
 * @param {number} limit - The maximum number of concurrent executions per batch.
 * @param {Array<T>} items - The array of items to process.
 * @param {(item: T) => Promise<R>} iteratorFn - The async function to apply to each item.
 * @returns {Promise<Array<R>>} - A promise that resolves when all items have been processed.
 */
export async function asyncPool<T, R>(
    limit: number,
    items: T[],
    iteratorFn: (item: T) => Promise<R>
  ): Promise<R[]> {
    const ret: R[] = [];
  
    for (let i = 0; i < items.length; i += limit) {
      const batchItems = items.slice(i, i + limit);
      const batchPromises = batchItems.map((item) => iteratorFn(item));
  
      // Wait for the current batch to complete before starting the next one
      const batchResults = await Promise.all(batchPromises);
      ret.push(...batchResults);
  
      // Optional: add a cooldown between batches
      // await new Promise((resolve) => setTimeout(resolve, 500));
    }
  
    return ret;
  }