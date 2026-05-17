class AppError extends Error {
  constructor(code, message, statusCode, details) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function toErrorPayload(error, fallbackCode, fallbackMessage) {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      error: {
        code: fallbackCode,
        message: fallbackMessage,
      },
    },
  };
}

function badRequest(code, message, details) {
  return new AppError(code, message, 400, details);
}

function notFound(code, message, details) {
  return new AppError(code, message, 404, details);
}

function gatewayTimeout(code, message, details) {
  return new AppError(code, message, 504, details);
}

module.exports = {
  AppError,
  toErrorPayload,
  badRequest,
  notFound,
  gatewayTimeout,
};