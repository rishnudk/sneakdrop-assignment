export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message?: string
  ) {
    super(message || code);
    this.name = 'AppError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
