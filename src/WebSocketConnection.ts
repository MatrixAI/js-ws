import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed, ContextTimedInput } from '@matrixai/contexts';
import type {
  ConnectionMetadata,
  Host,
  Port,
  RemoteInfo,
  StreamCodeToReason,
  StreamReasonToCode,
  WebSocketConfig,
} from './types';
import type { DetailedPeerCertificate, TLSSocket } from 'tls';
import type { StreamId } from './message';
import { startStop } from '@matrixai/async-init';
import { Lock } from '@matrixai/async-locks';
import { context, timedCancellable } from '@matrixai/contexts/dist/decorators';
import Logger from '@matrixai/logger';
import * as ws from 'ws';
import { Timer } from '@matrixai/timer';
import { AbstractEvent, EventAll, EventDefault } from '@matrixai/events';
import { concatUInt8Array } from './message';
import WebSocketStream from './WebSocketStream';
import * as errors from './errors';
import * as events from './events';
import { parseStreamId, StreamMessageType } from './message';
import * as utils from './utils';
import * as messageUtils from './message/utils';

const timerCleanupReasonSymbol = Symbol('timerCleanupReasonSymbol');

interface WebSocketConnection extends startStop.StartStop {}
/**
 * Think of this as equivalent to `net.Socket`.
 * This is one-to-one with the ws.WebSocket.
 * Errors here are emitted to the connection only.
 * Not to the server.
 *
 * Events:
 * - {@link events.EventWebSocketConnectionStream}
 * - {@link events.EventWebSocketConnectionStart}
 * - {@link events.EventWebSocketConnectionStarted}
 * - {@link events.EventWebSocketConnectionStop}
 * - {@link events.EventWebSocketConnectionStopped}
 * - {@link events.EventWebSocketConnectionError} - can occur due to a timeout too
 * - {@link events.EventWebSocketConnectionClose}
 * - {@link events.EventWebSocketStreamDestroy}
 * - {@link events.EventWebSocketStreamDestroyed}
 */
@startStop.StartStop({
  eventStart: events.EventWebSocketConnectionStart,
  eventStarted: events.EventWebSocketConnectionStarted,
  eventStop: events.EventWebSocketConnectionStop,
  eventStopped: events.EventWebSocketConnectionStopped,
})
class WebSocketConnection {
  /**
   * This determines when it is a client or server connection.
   */
  public readonly type: 'client' | 'server';

  /**
   * This is the source connection ID.
   */
  public readonly connectionId: number;

  /**
   * Internal native connection object.
   * @internal
   */
  protected socket: ws.WebSocket;

  protected config: WebSocketConfig;

  /**
   * Converts reason to code.
   * Used during `WebSocketStream` creation.
   */
  protected reasonToCode: StreamReasonToCode;

  /**
   * Converts code to reason.
   * Used during `WebSocketStream` creation.
   */
  protected codeToReason: StreamCodeToReason;

  /**
   * Internal stream map.
   * This is also used by `WebSocketStream`.
   * @internal
   */
  public readonly streamMap: Map<StreamId, WebSocketStream> = new Map();

  /**
   * Stream ID increment lock.
   */
  protected streamIdLock: Lock = new Lock();

  /**
   * Client initiated bidirectional stream starts at 0.
   * Increment by 4 to get the next ID.
   */
  protected streamIdClientBidi: StreamId = 0b00n as StreamId;

  /**
   * Server initiated bidirectional stream starts at 1.
   * Increment by 4 to get the next ID.
   */
  protected streamIdServerBidi: StreamId = 0b01n as StreamId;

  protected keepAliveTimeOutTimer?: Timer;
  protected keepAliveIntervalTimer?: Timer;

  protected logger: Logger;
  protected remoteHost: Host;
  protected remotePort: Port;
  protected localHost?: Host;
  protected localPort?: Port;
  protected peerCert?: DetailedPeerCertificate;

  protected handleEventWebSocketConnectionError = (
    evt: events.EventWebSocketConnectionError,
  ) => {
    const error = evt.detail;
    // In the case of graceful exit, we don't want to log out the error
    if (
      (error instanceof errors.ErrorWebSocketConnectionLocal ||
        error instanceof errors.ErrorWebSocketConnectionPeer) &&
      error.data?.errorCode === utils.ConnectionErrorCode.Normal
    ) {
      this.logger.info(utils.formatError(error));
    } else {
      this.logger.error(utils.formatError(error));
    }
  };

  protected handleEventWebSocketConnectionClose = async () => {
    if (this[startStop.running] && this[startStop.status] !== 'stopping') {
      // Failing to force stop is a software error
      await this.stop({
        force: true,
      });
    }
  };

  protected handleEventWebSocketStreamSend = async (
    evt: events.EventWebSocketStreamSend,
  ) => {
    await this.send(evt.msg);
  };

  protected handleEventWebSocketStreamStopped = (
    evt: events.EventWebSocketStreamStopped,
  ) => {
    const stream = evt.target as WebSocketStream;
    stream.removeEventListener(
      events.EventWebSocketStreamSend.name,
      this.handleEventWebSocketStreamSend,
    );
    stream.removeEventListener(EventAll.name, this.handleEventWebSocketStream);
    this.streamMap.delete(stream.streamId);
  };

  protected handleEventWebSocketStream = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
    }
  };

  protected closeLocally: boolean = false;
  protected closedP: Promise<void>;
  protected resolveClosedP: () => void;
  protected rejectClosedP: (reason?: any) => void;

  protected handleSocketMessage = async (
    data: ws.RawData,
    isBinary: boolean,
  ) => {
    if (!isBinary || data instanceof Array) {
      this.dispatchEvent(
        new events.EventWebSocketConnectionError({
          detail: new errors.ErrorWebSocketConnectionLocal(
            "data received isn't binary",
            {
              cause: new errors.ErrorWebSocketUndefinedBehaviour(),
            },
          ),
        }),
      );
      return;
    }
    let remainder: Uint8Array =
      data instanceof ArrayBuffer ? new Uint8Array(data) : data;

    let streamId;
    try {
      const { data: parsedStreamId, remainder: postStreamIdRemainder } =
        parseStreamId(remainder);
      streamId = parsedStreamId;
      remainder = postStreamIdRemainder;
    } catch (e) {
      // TODO: domain specific error
      this.dispatchEvent(
        new events.EventWebSocketConnectionError('parsing StreamId failed', {
          detail: new errors.ErrorWebSocketConnectionLocal(
            "data received isn't binary",
            {
              cause: e,
            },
          ),
        }),
      );
      return;
    }

    let stream = this.streamMap.get(streamId);
    if (stream == null) {
      // Because the stream code is 16 bits, and Ack is only the right-most bit set when encoded by big-endian,
      // we can assume that the second byte of the StreamMessageType.Ack will look the same as if it were encoded in a u8
      if (
        !(remainder.at(1) === StreamMessageType.Ack && remainder.at(0) === 0)
      ) {
        return;
      }
      stream = new WebSocketStream({
        initiated: 'peer',
        connection: this,
        streamId,
        bufferSize: this.config.streamBufferSize,
        reasonToCode: this.reasonToCode,
        codeToReason: this.codeToReason,
        logger: this.logger.getChild(`${WebSocketStream.name} ${streamId!}`),
      });
      this.streamMap.set(streamId, stream);
      stream.addEventListener(
        events.EventWebSocketStreamSend.name,
        this.handleEventWebSocketStreamSend,
      );
      stream.addEventListener(
        events.EventWebSocketStreamStopped.name,
        this.handleEventWebSocketStreamStopped,
        { once: true },
      );
      stream.addEventListener(EventAll.name, this.handleEventWebSocketStream);
      await stream.start();
      this.dispatchEvent(
        new events.EventWebSocketConnectionStream({
          detail: stream,
        }),
      );
    }

    await stream!.streamRecv(remainder);
  };

  protected handleSocketPing = () => {
    this.socket.pong();
  };

  protected handleSocketPong = () => {
    this.setKeepAliveTimeoutTimer();
  };

  protected handleSocketClose = (errorCode: number, reason: Buffer) => {
    this.resolveClosedP();
    // If this connection isn't closed by the peer, we don't need to event that it's closed
    if (this.closeLocally) {
      return;
    }
    const e_ = new errors.ErrorWebSocketConnectionPeer(
      `Peer closed with code ${errorCode}`,
      {
        data: {
          errorCode,
        },
      },
    );
    this.dispatchEvent(
      new events.EventWebSocketConnectionError({
        detail: e_,
      }),
    );
    this.dispatchEvent(
      new events.EventWebSocketConnectionClose({
        detail: {
          type: 'peer',
          errorCode,
          reason: reason.toString('utf-8'),
        },
      }),
    );
  };

  protected handleSocketError = (err: Error) => {
    const errorCode = utils.ConnectionErrorCode.InternalServerError;
    const reason = 'An error occurred on the underlying WebSocket instance';
    const e_ = new errors.ErrorWebSocketConnectionLocal(reason, {
      data: {
        errorCode,
      },
      cause: new errors.ErrorWebSocketConnectionInternal(reason, {
        cause: err,
      }),
    });
    this.dispatchEvent(
      new events.EventWebSocketConnectionError({
        detail: e_,
      }),
    );
    this.closeLocally = true;
    this.socket.close(errorCode, reason);
    this.dispatchEvent(
      new events.EventWebSocketConnectionClose({
        detail: {
          type: 'local',
          errorCode,
          reason,
        },
      }),
    );
  };

  @startStop.ready(new errors.ErrorWebSocketConnectionNotRunning())
  public meta(): ConnectionMetadata {
    return {
      localHost: this.localHost,
      localPort: this.localPort,
      remoteHost: this.remoteHost,
      remotePort: this.remotePort,
      peerCert: this.peerCert,
    };
  }

  public constructor({
    type,
    connectionId,
    meta,
    config,
    socket,
    reasonToCode = () => 0n,
    codeToReason = (type, code) => new Error(`${type} ${code}`),
    logger,
  }:
    | {
        type: 'client';
        connectionId: number;
        meta?: undefined;
        config: WebSocketConfig;
        socket: ws.WebSocket;
        reasonToCode?: StreamReasonToCode;
        codeToReason?: StreamCodeToReason;
        logger?: Logger;
      }
    | {
        type: 'server';
        connectionId: number;
        meta: ConnectionMetadata;
        config: WebSocketConfig;
        socket: ws.WebSocket;
        reasonToCode?: StreamReasonToCode;
        codeToReason?: StreamCodeToReason;
        logger?: Logger;
      }) {
    this.logger = logger ?? new Logger(`${this.constructor.name}`);
    this.connectionId = connectionId;
    this.socket = socket;
    this.config = config;
    this.type = type;
    this.reasonToCode = reasonToCode;
    this.codeToReason = codeToReason;

    if (meta != null) {
      this.remoteHost = meta.remoteHost as Host;
      this.remotePort = meta.remotePort as Port;
      this.localHost = meta.localHost as Host | undefined;
      this.localPort = meta.localPort as Port | undefined;
      this.peerCert = meta.peerCert;
    }

    const {
      p: closedP,
      resolveP: resolveClosedP,
      rejectP: rejectClosedP,
    } = utils.promise<void>();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;
    this.rejectClosedP = rejectClosedP;
  }

  public start(ctx?: Partial<ContextTimedInput>): PromiseCancellable<void>;
  @timedCancellable(true, Infinity, errors.ErrorWebSocketConnectionStartTimeOut)
  public async start(@context ctx: ContextTimed): Promise<void> {
    this.logger.info(`Start ${this.constructor.name}`);
    ctx.signal.throwIfAborted();
    const { p: abortP, rejectP: rejectAbortP } = utils.promise<never>();
    const abortHandler = () => {
      rejectAbortP(ctx.signal.reason);
    };
    ctx.signal.addEventListener('abort', abortHandler);

    const promises: Array<Promise<any>> = [];

    const connectProm = utils.promise<void>();

    if (this.socket.readyState === ws.OPEN) {
      connectProm.resolveP();
    }
    // Handle connection failure
    const openErrorHandler = (e) => {
      connectProm.rejectP(
        new errors.ErrorWebSocketConnection(undefined, {
          cause: e,
        }),
      );
    };
    this.socket.once('error', openErrorHandler);
    const openHandler = () => {
      connectProm.resolveP();
    };
    this.socket.once('open', openHandler);
    promises.push(connectProm.p);

    if (this.type === 'client') {
      const authenticateProm = utils.promise<void>();
      this.socket.once('upgrade', async (request) => {
        const tlsSocket = request.socket as TLSSocket;
        const peerCert = tlsSocket.getPeerCertificate(true);
        try {
          if (this.config.verifyPeer && this.config.verifyCallback != null) {
            await this.config.verifyCallback?.(peerCert);
          }
          this.localHost = request.connection.localAddress as Host;
          this.localPort = request.connection.localPort as Port;
          this.remoteHost = request.connection.remoteAddress as Host;
          this.remotePort = request.connection.remotePort as Port;
          this.peerCert = peerCert;
          authenticateProm.resolveP();
        } catch (e) {
          const errorCode = utils.ConnectionErrorCode.TLSHandshake;
          const e_ = new errors.ErrorWebSocketConnectionLocal(
            'Failed connection due to custom verification callback',
            {
              cause: e,
              data: {
                errorCode,
              },
            },
          );
          this.dispatchEvent(
            new events.EventWebSocketConnectionError({
              detail: e_,
            }),
          );
          this.closeLocally = true;
          this.socket.close(errorCode);
          this.dispatchEvent(
            new events.EventWebSocketConnectionClose({
              detail: {
                type: 'local',
                errorCode: utils.ConnectionErrorCode.TLSHandshake,
                reason: e_.message,
              },
            }),
          );
          authenticateProm.rejectP(e_);
        }
      });
      promises.push(authenticateProm.p);
    }

    // Wait for open
    try {
      await Promise.race([Promise.all(promises), abortP]);
    } catch (e) {
      // Socket may already be closed from authentication error
      this.closeLocally = true;
      const errorCode = utils.ConnectionErrorCode.ProtocolError;
      if (ctx.signal.aborted) {
        const e_ = new errors.ErrorWebSocketConnectionLocal(
          'Failed to start WebSocket connection due to start timeout',
          {
            cause: e,
            data: {
              errorCode,
            },
          },
        );
        this.dispatchEvent(
          new events.EventWebSocketConnectionError({
            detail: e_,
          }),
        );
        this.closeLocally = true;
        this.socket.close(errorCode);
        this.dispatchEvent(
          new events.EventWebSocketConnectionClose({
            detail: {
              type: 'local',
              errorCode: utils.ConnectionErrorCode.ProtocolError,
              reason: e_.message,
            },
          }),
        );
      }

      this.socket.off('open', openHandler);
      // Upgrade only exists on the ws library, we can use removeAllListeners without worrying
      this.socket.removeAllListeners('upgrade');
      // Close the ws if it's open at this stage

      await this.closedP;

      throw e;
    } finally {
      ctx.signal.removeEventListener('abort', abortHandler);
      // Upgrade has already been removed by being called once or by the catch
      this.socket.off('error', openErrorHandler);
    }

    // Set the connection up
    this.socket.on('message', this.handleSocketMessage);
    this.socket.on('ping', this.handleSocketPing);
    this.socket.on('pong', this.handleSocketPong);
    this.socket.once('error', this.handleSocketError);
    this.socket.once('close', this.handleSocketClose);

    if (this.config.keepAliveIntervalTime != null) {
      this.startKeepAliveIntervalTimer(this.config.keepAliveIntervalTime);
    }

    this.addEventListener(
      events.EventWebSocketConnectionError.name,
      this.handleEventWebSocketConnectionError,
    );
    this.addEventListener(
      events.EventWebSocketConnectionClose.name,
      this.handleEventWebSocketConnectionClose,
      { once: true },
    );

    this.logger.info(`Started ${this.constructor.name}`);
  }

  @startStop.ready(new errors.ErrorWebSocketConnectionNotRunning())
  public async streamNew(): Promise<WebSocketStream> {
    return await this.streamIdLock.withF(async () => {
      let streamId: StreamId;
      if (this.type === 'client') {
        streamId = this.streamIdClientBidi;
      } else if (this.type === 'server') {
        streamId = this.streamIdServerBidi;
      }
      const stream = new WebSocketStream({
        initiated: 'local',
        streamId: streamId!,
        connection: this,
        bufferSize: this.config.streamBufferSize,
        codeToReason: this.codeToReason,
        reasonToCode: this.reasonToCode,
        logger: this.logger.getChild(`${WebSocketStream.name} ${streamId!}`),
      });
      this.streamMap.set(streamId!, stream);
      stream.addEventListener(
        events.EventWebSocketStreamSend.name,
        this.handleEventWebSocketStreamSend,
      );
      stream.addEventListener(
        events.EventWebSocketStreamStopped.name,
        this.handleEventWebSocketStreamStopped,
        { once: true },
      );
      stream.addEventListener(EventAll.name, this.handleEventWebSocketStream);
      await stream.start();
      // Ok the stream is opened and working
      if (this.type === 'client') {
        this.streamIdClientBidi = (this.streamIdClientBidi + 2n) as StreamId;
      } else if (this.type === 'server') {
        this.streamIdServerBidi = (this.streamIdServerBidi + 2n) as StreamId;
      }
      return stream;
    });
  }

  /**
   * Send data on the WebSocket
   * @internal
   */
  public async send(data: Uint8Array | Array<Uint8Array>) {
    let array: Uint8Array;
    if (ArrayBuffer.isView(data)) {
      array = data;
    } else {
      array = concatUInt8Array(...data);
    }
    try {
      const sendProm = utils.promise<void>();
      this.socket.send(array, { binary: true }, (err) => {
        if (err == null) sendProm.resolveP();
        else sendProm.rejectP(err);
      });
      await sendProm.p;
    } catch (err) {
      if (this[startStop.status] === 'stopping') {
        this.logger.debug('send error but already stopping');
        return;
      }
      this.closeLocally = true;
      const errorCode = utils.ConnectionErrorCode.InternalServerError;
      const reason = 'connection was unable to send data';
      const e_ = new errors.ErrorWebSocketConnectionLocal(reason, {
        cause: new errors.ErrorWebSocketServerInternal(reason, {
          cause: err,
        }),
        data: {
          errorCode,
        },
      });
      this.dispatchEvent(
        new events.EventWebSocketConnectionError({
          detail: e_,
        }),
      );
      this.closeLocally = true;
      this.socket.close(errorCode, reason);
      this.dispatchEvent(
        new events.EventWebSocketConnectionClose({
          detail: {
            type: 'local',
            errorCode,
            reason,
          },
        }),
      );
      // Will not wait for close, happens asynchronously
    }
  }

  public async stop({
    errorCode = utils.ConnectionErrorCode.Normal,
    errorMessage = '',
    force = true,
  }: {
    errorCode?: number;
    errorMessage?: string;
    force?: boolean;
  } = {}) {
    this.logger.info(`Stop ${this.constructor.name}`);
    // Remove event listeners before possible event dispatching to avoid recursion
    this.removeEventListener(
      events.EventWebSocketConnectionError.name,
      this.handleEventWebSocketConnectionError,
    );
    this.removeEventListener(
      events.EventWebSocketConnectionClose.name,
      this.handleEventWebSocketConnectionClose,
    );
    this.stopKeepAliveIntervalTimer();

    // Cleaning up existing streams
    const streamsDestroyP: Array<Promise<void>> = [];
    this.logger.debug('triggering stream destruction');
    for (const stream of this.streamMap.values()) {
      if (force) {
        await stream.stop();
      }
      streamsDestroyP.push(stream.closedP);
    }
    this.logger.debug('waiting for streams to destroy');
    await Promise.all(streamsDestroyP);
    this.logger.debug('streams destroyed');

    // Socket Cleanup
    if (this.socket.readyState === ws.CLOSED) {
      this.resolveClosedP();
    } else {
      const e = new errors.ErrorWebSocketConnectionLocal(
        `Locally closed with code ${errorCode}`,
        {
          data: {
            errorCode,
          },
        },
      );
      this.dispatchEvent(
        new events.EventWebSocketConnectionError({ detail: e }),
      );
      this.closeLocally = true;
      this.socket.close(errorCode, errorMessage);
      this.dispatchEvent(
        new events.EventWebSocketConnectionClose({
          detail: {
            type: 'local',
            errorCode,
            reason: errorMessage,
          },
        }),
      );
    }
    await this.closedP;
    this.socket.off('message', this.handleSocketMessage);
    this.socket.off('ping', this.handleSocketPing);
    this.socket.off('pong', this.handleSocketPong);
    this.socket.off('error', this.handleSocketError);
    this.keepAliveTimeOutTimer?.cancel(timerCleanupReasonSymbol);

    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  protected setKeepAliveTimeoutTimer(): void {
    const logger = this.logger.getChild('timer');
    const timeout = this.config.keepAliveTimeoutTime;
    const keepAliveTimeOutHandler = () => {
      if (this.socket.readyState === ws.CLOSED) {
        this.resolveClosedP();
        return;
      }
      this.dispatchEvent(
        new events.EventWebSocketConnectionError({
          detail: new errors.ErrorWebSocketConnectionKeepAliveTimeOut(),
        }),
      );
      this.dispatchEvent(
        new events.EventWebSocketConnectionClose({
          detail: {
            type: 'timeout',
          },
        }),
      );
    };
    // If there was an existing timer, we cancel it and set a new one
    if (
      this.keepAliveTimeOutTimer != null &&
      this.keepAliveTimeOutTimer.status === null
    ) {
      // Logger.debug(`resetting timer with ${timeout} delay`);
      this.keepAliveTimeOutTimer.reset(timeout);
    } else {
      logger.debug(`timeout created with delay ${timeout}`);
      this.keepAliveTimeOutTimer = new Timer({
        delay: timeout,
        handler: keepAliveTimeOutHandler,
      });
    }
  }

  protected startKeepAliveIntervalTimer(ms: number): void {
    const keepAliveHandler = async () => {
      this.socket.ping();
      this.keepAliveIntervalTimer = new Timer({
        delay: ms,
        handler: keepAliveHandler,
      });
    };
    this.keepAliveIntervalTimer = new Timer({
      delay: ms,
      handler: keepAliveHandler,
    });
  }

  /**
   * Stops the keep alive interval timer
   */
  protected stopKeepAliveIntervalTimer(): void {
    this.keepAliveIntervalTimer?.cancel(timerCleanupReasonSymbol);
  }
}

export default WebSocketConnection;
