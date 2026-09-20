export class DomainError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
  }
}

export function asDomainError(error: unknown) {
  if (error instanceof DomainError) return error;
  if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
    return new DomainError("conflict", "The requested record already exists", 409);
  }
  if (error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message)) {
    return new DomainError("invalid_reference", "Referenced record does not exist", 400);
  }
  return new DomainError("internal_error", "Internal server error", 500);
}

