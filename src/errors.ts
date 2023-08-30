import { AbstractError } from '@matrixai/errors';

class ErrorWebSocket<T> extends AbstractError<T> {
  static description = 'WebSocket error';
}

// Server

class ErrorWebSocketServer<T> extends ErrorWebSocket<T> {
  static description = 'WebSocket Server error';
}

class ErrorWebSocketServerNotRunning<T> extends ErrorWebSocketServer<T> {
  static description = 'WebSocket Server is not running';
}

// Client

class ErrorWebSocketClient<T> extends ErrorWebSocket<T> {
  static description = 'WebSocket Client error';
}

class ErrorWebSocketClientCreateTimeOut<T> extends ErrorWebSocketClient<T> {
  static description = 'WebSocketC Client create timeout';
}

class ErrorWebSocketClientDestroyed<T> extends ErrorWebSocketClient<T> {
  static description = 'WebSocket Client is destroyed';
}

class ErrorWebSocketClientInvalidHost<T> extends ErrorWebSocketClient<T> {
  static description =
    'WebSocket Client cannot be created with the specified host';
}

// Connection

class ErrorWebSocketConnection<T> extends ErrorWebSocket<T> {
  static description = 'WebSocket Connection error';
}

class ErrorWebSocketConnectionNotRunning<
  T,
> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection is not running';
}

class ErrorWebSocketConnectionStartTimeOut<
  T,
> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection start timeout';
}

class ErrorWebSocketConnectionKeepAliveTimeOut<
  T,
> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection reached idle timeout';
}

class ErrorWebSocketConnectionSocket<T> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection underlying websocket error';
}

// Stream

class ErrorWebSocketStream<T> extends ErrorWebSocket<T> {
  static description = 'WebSocket Stream error';
}

class ErrorWebSocketStreamReader<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream readable error';
}

class ErrorWebSocketStreamReaderParse<T> extends ErrorWebSocketStreamReader<T> {
  static description = 'WebSocket Stream readable message parse failed';
}

class ErrorWebSocketStreamReaderBufferOverload<T> extends ErrorWebSocket<T> {
  static description = 'WebSocket Stream readable buffer has overloaded';
}

class ErrorWebSocketStreamDestroyed<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream is destroyed';
}

// Misc

class ErrorWebSocketUndefinedBehaviour<T> extends ErrorWebSocket<T> {
  static description = 'This should never happen';
}

export {
  ErrorWebSocket,
  ErrorWebSocketServer,
  ErrorWebSocketServerNotRunning,
  ErrorWebSocketClient,
  ErrorWebSocketClientCreateTimeOut,
  ErrorWebSocketClientDestroyed,
  ErrorWebSocketClientInvalidHost,
  ErrorWebSocketConnection,
  ErrorWebSocketConnectionNotRunning,
  ErrorWebSocketConnectionStartTimeOut,
  ErrorWebSocketConnectionKeepAliveTimeOut,
  ErrorWebSocketConnectionSocket,
  ErrorWebSocketStream,
  ErrorWebSocketStreamReader,
  ErrorWebSocketStreamReaderParse,
  ErrorWebSocketStreamReaderBufferOverload,
  ErrorWebSocketStreamDestroyed,
  ErrorWebSocketUndefinedBehaviour,
};
