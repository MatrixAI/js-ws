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

class ErrorWebSocketStreamDestroyed<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream is destroyed';
}

class ErrorWebSocketStreamLocalRead<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream locally closed readable side';
}

class ErrorWebSocketStreamLocalWrite<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream locally closed writable side';
}

class ErrorWebSocketStreamPeerRead<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream peer closed readable side';
}

class ErrorWebSocketStreamPeerWrite<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream peer closed writable side';
}

class ErrorWebSocketStreamInternal<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream internal error';
}

// Stream Protocol Errors

class ErrorWebSocketStreamUnknown<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream readable buffer has overloaded';
}

class ErrorWebSocketStreamReadableParse<T> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream readable buffer has overloaded';
}

class ErrorWebSocketStreamReadableBufferOverload<
  T,
> extends ErrorWebSocketStream<T> {
  static description = 'WebSocket Stream readable buffer has overloaded';
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
  ErrorWebSocketStreamDestroyed,
  ErrorWebSocketStreamLocalRead,
  ErrorWebSocketStreamLocalWrite,
  ErrorWebSocketStreamPeerRead,
  ErrorWebSocketStreamPeerWrite,
  ErrorWebSocketStreamInternal,
  ErrorWebSocketStreamUnknown,
  ErrorWebSocketStreamReadableParse,
  ErrorWebSocketStreamReadableBufferOverload,
  ErrorWebSocketUndefinedBehaviour,
};
