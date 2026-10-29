import { HttpException, HttpStatus } from '@nestjs/common';

export type ErrorDetails = Readonly<Record<string, unknown>>;

export class DomainError extends HttpException {
  readonly code: string;

  constructor(
    status: HttpStatus,
    code: string,
    message: string,
    details?: ErrorDetails,
  ) {
    super({ error: { code, message, ...(details ? { details } : {}) } }, status);
    this.code = code;
  }
}

export class DomainValidationError extends DomainError {
  constructor(code: string, message: string, details?: ErrorDetails) {
    super(HttpStatus.BAD_REQUEST, code, message, details);
  }
}

export class DomainNotFoundError extends DomainError {
  constructor(code: string, message: string, details?: ErrorDetails) {
    super(HttpStatus.NOT_FOUND, code, message, details);
  }
}

export class DomainConflictError extends DomainError {
  constructor(code: string, message: string, details?: ErrorDetails) {
    super(HttpStatus.CONFLICT, code, message, details);
  }
}
