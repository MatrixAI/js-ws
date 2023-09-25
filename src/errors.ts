import type { POJO } from '@matrixai/errors';
import type { ConnectionError } from './types';
import { AbstractError } from '@matrixai/errors';

class ErrorWebSocket<T> extends AbstractError<T> {
  static description = 'WebSocket error';
}

class ErrorWebSocketHostInvalid<T> extends AbstractError<T> {
  static description = 'Host provided was not valid';
}

class ErrorWebSocketPortInvalid<T> extends AbstractError<T> {
  static description = 'Port provided was not valid';
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

// Connection

class ErrorWebSocketConnection<T> extends ErrorWebSocket<T> {
  static description = 'WebSocket Connection error';
}

class ErrorWebSocketConnectionNotRunning<
  T,
> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection is not running';
}

class ErrorWebSocketConnectionClosed<T> extends ErrorWebSocketConnection<T> {
  static description =
    'WebSocket Connection cannot be restarted because it has already been closed';
}

class ErrorWebSocketConnectionStartTimeOut<
  T,
> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection start timeout';
}

class ErrorWebSocketConnectionKeepAliveTimeOut<
  T,
> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection reached keep-alive timeout';
}

class ErrorWebSocketConnectionInternal<T> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection internal error';
}

/**
 * Note that TlsFail error codes are documented here:
 * https://github.com/google/boringssl/blob/master/include/openssl/ssl.h
 */
class ErrorWebSocketConnectionLocal<T> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection local error';
  declare data: POJO & ConnectionError;
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO & ConnectionError;
      cause?: T;
    },
  ) {
    super(message, options);
  }
}

class ErrorWebSocketConnectionLocalTLS<
  T,
> extends ErrorWebSocketConnectionLocal<T> {
  static description = 'WebSocket Connection local TLS error';
}

class ErrorWebSocketConnectionPeer<T> extends ErrorWebSocketConnection<T> {
  static description = 'WebSocket Connection peer error';
  declare data: POJO & ConnectionError;
  constructor(
    message: string = '',
    options: {
      timestamp?: Date;
      data: POJO & ConnectionError;
      cause?: T;
    },
  ) {
    super(message, options);
  }
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
  ErrorWebSocketHostInvalid,
  ErrorWebSocketPortInvalid,
  ErrorWebSocketServer,
  ErrorWebSocketServerNotRunning,
  ErrorWebSocketServerInternal,
  ErrorWebSocketClient,
  ErrorWebSocketClientCreateTimeOut,
  ErrorWebSocketClientDestroyed,
  ErrorWebSocketConnection,
  ErrorWebSocketConnectionNotRunning,
  ErrorWebSocketConnectionClosed,
  ErrorWebSocketConnectionStartTimeOut,
  ErrorWebSocketConnectionKeepAliveTimeOut,
  ErrorWebSocketConnectionLocal,
  ErrorWebSocketConnectionLocalTLS,
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
