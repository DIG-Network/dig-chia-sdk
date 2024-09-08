/**
 * Verifies if a connection string is valid based on the given format.
 *
 * Format: hostname:port (optional)
 *
 * @param {string} connectionString - The connection string to verify.
 * @returns {boolean} - Returns true if the connection string is valid, otherwise false.
 */
export const verifyConnectionString = (connectionString: string): boolean => {
  // Define the regular expression pattern to match a hostname with an optional port
  const pattern: RegExp = /^(?!:\/\/)([a-zA-Z0-9.-]+)(:\d{1,5})?$/;

  // Test the connection string against the pattern
  return pattern.test(connectionString);
};
