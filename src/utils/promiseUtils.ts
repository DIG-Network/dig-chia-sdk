
/**
 * Processes items in sequential batches with a concurrency limit.
 * Adds a cooldown between batches.
 * @param {number} limit - The maximum number of concurrent executions per batch.
 * @param {Array<T>} items - The array of items to process.
 * @param {(item: T) => Promise<R>} iteratorFn - The async function to apply to each item.
 * @param {number} cooldownMs - The cooldown duration between batches in milliseconds.
 * @returns {Promise<Array<R>>} - A promise that resolves when all items have been processed.
 */
export async function asyncPool<T, R>(
  limit: number,
  items: T[],
  iteratorFn: (item: T) => Promise<R>,
  cooldownMs: number = 500 // Default cooldown of 500ms
): Promise<R[]> {
  const ret: R[] = [];

  for (let i = 0; i < items.length; i += limit) {
    const batchItems = items.slice(i, i + limit);
    const batchPromises = batchItems.map((item) => iteratorFn(item));

    // Wait for the current batch to complete before starting the next one
    const batchResults = await Promise.all(batchPromises);
    ret.push(...batchResults);

    // Add a cooldown between batches, except after the last batch
    if (i + limit < items.length) {
      await new Promise((resolve) => setTimeout(resolve, cooldownMs));
    }
  }

  return ret;
}
  /**
 * Helper function to add a timeout to a promise.
 * @param promise The original promise.
 * @param ms Timeout in milliseconds.
 * @param timeoutMessage The error message when the timeout is reached.
 * @returns Promise that resolves before the timeout or rejects with an error.
 */
export const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string
): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(timeoutMessage)), ms)
    ),
  ]);
};

/**
 * Wraps a promise to execute a callback every 30 seconds while the promise is pending.
 *
 * @param {Promise<T>} promise - The promise to wrap.
 * @param {() => void} callback - The callback function to call every 30 seconds.
 * @returns {Promise<T>} - A new promise that resolves or rejects with the original promise's result.
 */
export const withIntervalCallback = <T>(
  promise: Promise<T>,
  callback: () => void
): Promise<T> => {
  const intervalTime = 30000; // 30 seconds in milliseconds

  let intervalId: NodeJS.Timeout;

  // Start the interval that calls the callback every 30 seconds
  intervalId = setInterval(() => {
    callback();
  }, intervalTime);

  // Return a new promise that clears the interval when the original promise settles
  return promise
    .then((result) => {
      clearInterval(intervalId);
      return result;
    })
    .catch((error) => {
      clearInterval(intervalId);
      throw error;
    });
};