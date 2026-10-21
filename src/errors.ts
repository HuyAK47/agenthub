export class HttpError extends Error {
  constructor(public statusCode: number, public error: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}
