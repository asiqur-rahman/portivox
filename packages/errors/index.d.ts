export type ErrorPayload = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export class AppError extends Error {
  code: string;
  statusCode: number;
  details?: unknown;
  constructor(code: string, message: string, statusCode: number, details?: unknown);
}

export function toErrorPayload(error: unknown, fallbackCode: string, fallbackMessage: string): {
  statusCode: number;
  body: ErrorPayload;
};

export function badRequest(code: string, message: string, details?: unknown): AppError;
export function notFound(code: string, message: string, details?: unknown): AppError;
export function gatewayTimeout(code: string, message: string, details?: unknown): AppError;