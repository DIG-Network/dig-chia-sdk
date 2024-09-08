import superagent from "superagent";

// Helper function to log API requests and responses if DIG_DEBUG is enabled
export const logApiRequest = async (request: superagent.SuperAgentRequest) => {
  if (process.env.DIG_DEBUG === "1") {
    console.group("API Request");

    console.log(
      `%cMethod: %c${request.method.toUpperCase()}`,
      "font-weight: bold;",
      "color: cyan;"
    );
    console.log(
      `%cURL: %c${request.url}`,
      "font-weight: bold;",
      "color: cyan;"
    );

    // @ts-ignore
    if (request.header) {
      console.groupCollapsed("%cHeaders", "font-weight: bold;");
      // @ts-ignore
      console.table(request.header);
      console.groupEnd();
    }

    // @ts-ignore
    if (request._data) {
      console.groupCollapsed("%cBody", "font-weight: bold;");
      // @ts-ignore
      const requestBody = JSON.parse(JSON.stringify(request._data));
      if (typeof requestBody === "object" && requestBody !== null) {
        for (const [key, value] of Object.entries(requestBody)) {
          console.groupCollapsed(
            `%c${key}`,
            "font-weight: bold; border: 1px solid #ccc; padding: 2px;"
          );
          if (Array.isArray(value) || typeof value === "object") {
            console.table(value);
          } else {
            console.log(`%c${value}`, "border: 1px solid #ccc; padding: 2px;");
          }
          console.groupEnd();
        }
      } else {
        console.log(
          `%c${requestBody}`,
          "border: 1px solid #ccc; padding: 2px;"
        );
      }
      console.groupEnd();
    }

    console.groupEnd();

    try {
      const response = await request;

      console.group("API Response");

      console.log(
        `%cStatus: %c${response.status} ${response.statusCode}`,
        "font-weight: bold;",
        "color: green;"
      );
      console.groupCollapsed(
        "%cHeaders",
        "font-weight: bold; border: 1px solid #ccc; padding: 2px;"
      );
      console.table(response.headers);
      console.groupEnd();

      console.groupCollapsed("%cBody", "font-weight: bold;");
      const responseBody = response.body;
      if (typeof responseBody === "object" && responseBody !== null) {
        for (const [key, value] of Object.entries(responseBody)) {
          console.groupCollapsed(
            `%c${key}`,
            "font-weight: bold; border: 1px solid #ccc; padding: 2px;"
          );
          if (Array.isArray(value) || typeof value === "object") {
            console.table(value);
          } else {
            console.log(`%c${value}`, "border: 1px solid #ccc; padding: 2px;");
          }
          console.groupEnd();
        }
      } else {
        console.log(
          `%c${responseBody}`,
          "border: 1px solid #ccc; padding: 2px;"
        );
      }
      console.groupEnd();

      console.groupEnd();

      return response;
    } catch (error: any) {
      console.group("API Response");

      if (error.response) {
        console.log(
          `%cStatus: %c${error.response.status} ${error.response.statusText}`,
          "font-weight: bold;",
          "color: red;"
        );
        console.groupCollapsed(
          "%cHeaders",
          "font-weight: bold; border: 1px solid #ccc; padding: 2px;"
        );
        console.table(error.response.headers);
        console.groupEnd();

        console.groupCollapsed("%cBody", "font-weight: bold;");
        const errorBody = error.response.body;
        if (typeof errorBody === "object" && errorBody !== null) {
          for (const [key, value] of Object.entries(errorBody)) {
            console.groupCollapsed(
              `%c${key}`,
              "font-weight: bold; border: 1px solid #ccc; padding: 2px;"
            );
            if (Array.isArray(value) || typeof value === "object") {
              console.table(value);
            } else {
              console.log(
                `%c${value}`,
                "border: 1px solid #ccc; padding: 2px;"
              );
            }
            console.groupEnd();
          }
        } else {
          console.log(
            `%c${errorBody}`,
            "border: 1px solid #ccc; padding: 2px;"
          );
        }
        console.groupEnd();
      } else {
        console.error(`Request failed: ${error.message}`);
      }

      console.groupEnd();

      throw error;
    }
  } else {
    return request;
  }
};
