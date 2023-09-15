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

class ErrorWebSocketServerInternal<T> extends ErrorWebSocketServer<T> {
  static description = 'WebSocket Server internal error';
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

class ErrorWebSocketConnectionInternal<T> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection internal error';
}

/**
 * Note that TlsFail error codes are documented here:
 * https://github.com/google/boringssl/blob/master/include/openssl/ssl.h
 * This can mean local closure of any code!
 */
class ErrorWebSocketConnectionLocal<T> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection local error';
}

class ErrorWebSocketConnectionPeer<T> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection peer error';
}

// Stream

class ErrorWebSocketStream<T> extends ErrorWebSocket<T> {
  static description = 'WebSocket Stream error';
}

class ErrorWebSocketStreamUnknown<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream unknown error';
}

class ErrorWebSocketStreamReadableParse<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream readable message parse failed';
}

class ErrorWebSocketStreamReadableBufferOverload<
  T,
> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream readable buffer has overloaded';
}

class ErrorWebSocketStreamDestroyed<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream is destroyed';
}

class ErrorWebSocketStreamClose<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream force close';
}

class ErrorWebSocketStreamCancel<T> extends ErrorWebSocketStream<T> {
  static description =
    'WebSocket Stream was cancelled without a provided reason';
}

// Misc

class ErrorWebSocketUndefinedBehaviour<T> extends ErrorWebSocket<T> {
  static description = 'This should never happen';
}

export {
  ErrorWebSocket,
  ErrorWebSocketServer,
  ErrorWebSocketServerNotRunning,
  ErrorWebSocketServerInternal,
  ErrorWebSocketClient,
  ErrorWebSocketClientCreateTimeOut,
  ErrorWebSocketClientDestroyed,
  ErrorWebSocketClientInvalidHost,
  ErrorWebSocketConnection,
  ErrorWebSocketConnectionNotRunning,
  ErrorWebSocketConnectionStartTimeOut,
  ErrorWebSocketConnectionKeepAliveTimeOut,
  ErrorWebSocketConnectionLocal,
  ErrorWebSocketConnectionPeer,
  ErrorWebSocketConnectionInternal,
  ErrorWebSocketStream,
  ErrorWebSocketStreamUnknown,
  ErrorWebSocketStreamReadableParse,
  ErrorWebSocketStreamReadableBufferOverload,
  ErrorWebSocketStreamDestroyed,
  ErrorWebSocketStreamClose,
  ErrorWebSocketStreamCancel,
  ErrorWebSocketUndefinedBehaviour,
};
