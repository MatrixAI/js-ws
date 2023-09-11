import type { PromiseDeconstructed } from './types';
import * as errors from './errors';

function never(message?: string): never {
  throw new errors.ErrorWebSocketUndefinedBehaviour(message);
}

/**
 * Deconstructed promise
 */
function promise<T = void>(): PromiseDeconstructed<T> {
  let resolveP, rejectP;
  const p = new Promise<T>((resolve, reject) => {
    resolveP = resolve;
    rejectP = reject;
  });
  return {
    p,
    resolveP,
    rejectP,
  };
}

/**
 * WebSocketConnection error/close codes
 * sourced from: https://www.iana.org/assignments/websocket/websocket.xml
 */
enum ConnectionErrorCode {
  Normal = 1000,
  GoingAway = 1001,
  ProtocolError = 1002,
  UnsupportedData = 1003,
  NoStatusReceived = 1005,
  AbnormalClosure = 1006,
  InvalidFramePayloadData = 1007,
  PolicyViolation = 1008,
  MessageTooBig = 1009,
  MandatoryExtension = 1010,
  InternalServerError = 1011,
  ServiceRestart = 1012,
  TryAgainLater = 1013,
  BadGateway = 1014,
  TLSHandshake = 1015,
}

export { never, promise, ConnectionErrorCode };
