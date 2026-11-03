import type { ApiErrorCode } from '@allibot/shared';

/**
 * A failure that already knows its HTTP status and error-envelope code. The
 * HTTP layer renders it verbatim; anything else becomes a generic 500 without
 * leaking internal details.
 */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }

  static validation(message: string, details?: unknown): ApiFailure {
    return new ApiFailure(400, 'validation_failed', message, details);
  }

  static notFound(message: string): ApiFailure {
    return new ApiFailure(404, 'not_found', message);
  }

  static conflict(message: string, details?: unknown): ApiFailure {
    return new ApiFailure(409, 'conflict', message, details);
  }
}
