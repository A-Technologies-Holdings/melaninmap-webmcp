/**
 * Run an operation once more only when its first failure is explicitly
 * retryable. The same closure is reused, so callers retain operation-bound
 * tokens and idempotency keys across a dropped response.
 */
export async function retryOnceOnTransient<T>(
  operation: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isRetryable(error)) throw error;
    return operation();
  }
}
