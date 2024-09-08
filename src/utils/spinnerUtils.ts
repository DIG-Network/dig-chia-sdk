import { createSpinner, Spinner } from "nanospinner";

export const waitForPromise = async <T>(
  promiseFn: () => Promise<T>,
  spinnerText: string = "Processing...",
  successText: string = "OK!",
  errorText: string = "Error."
): Promise<T> => {
  const spinner: Spinner = createSpinner(spinnerText).start();

  // Store original console.log and console.error, and collect log messages
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  let logMessages: string[] = [];
  let errorMessages: string[] = [];

  console.log = (...args: any[]) => {
    logMessages.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };

  console.error = (...args: any[]) => {
    errorMessages.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };

  try {
    const result = await promiseFn();
    if (result) {
      spinner.success({ text: successText });
    } else {
      throw new Error(errorText);
    }

    return result;
  } catch (error) {
    spinner.error({ text: errorText });

    // Print collected log messages and error messages on error
    if (logMessages.length > 0) {
      originalConsoleLog("\nCollected logs:");
      logMessages.forEach((message) => originalConsoleLog(message));
    }

    if (errorMessages.length > 0) {
      originalConsoleError("\nCollected errors:");
      errorMessages.forEach((message) => originalConsoleError(message));
    }

    throw error;
  } finally {
    // Restore the original console.log and console.error functions
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
};
