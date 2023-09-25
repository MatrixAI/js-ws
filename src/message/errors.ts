import { AbstractError } from '@matrixai/errors';

class ErrorStreamMessage<T> extends AbstractError<T> {
  static description = 'Stream Message error';
}

class ErrorStreamParse<T> extends ErrorStreamMessage<T> {
  static description = 'Stream Message parse error';
}

class ErrorStreamGenerate<T> extends ErrorStreamMessage<T> {
  static description = 'Stream Message generation error';
}

export { ErrorStreamMessage, ErrorStreamParse, ErrorStreamGenerate };
