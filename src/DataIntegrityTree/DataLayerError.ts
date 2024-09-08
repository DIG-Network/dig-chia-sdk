class DataLayerError extends Error {
    code: number;
  
    constructor(code: number, message: string) {
      // Call the parent constructor with the message
      super(message);
  
      // Set the name of the error to the class name
      this.name = this.constructor.name;
  
      // Assign the custom code
      this.code = code;
  
      // Capture the stack trace (if available in the environment)
      if (Error.captureStackTrace) {
        Error.captureStackTrace(this, this.constructor);
      }
    }
  }
  
  export default DataLayerError;
  