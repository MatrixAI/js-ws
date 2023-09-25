import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed, ContextTimedInput } from '@matrixai/contexts';
import type {
  ConnectionMetadata,
  Host,
  Port,
  StreamCodeToReason,
  StreamReasonToCode,
  WebSocketConfig,
} from './types';
import type { TLSSocket } from 'tls';
import type { StreamId } from './message';
import { startStop } from '@matrixai/async-init';
import { Lock } from '@matrixai/async-locks';
import { context, timedCancellable } from '@matrixai/contexts/dist/decorators';
import Logger from '@matrixai/logger';
import * as ws from 'ws';
import { Timer } from '@matrixai/timer';
import { AbstractEvent, EventAll } from '@matrixai/events';
import { concatUInt8Array } from './message';
import WebSocketStream from './WebSocketStream';
import * as errors from './errors';
import * as events from './events';
import { parseStreamId, StreamMessageType } from './message';
import * as utils from './utils';
import { connectTimeoutTime } from './config';

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
 * - {@link events.EventWebSocketStream} - all dispatched events from {@link WebSocketStream}
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
   * Internal stream map.
   * @internal
   */
  protected streamMap: Map<StreamId, WebSocketStream> = new Map();

  protected logger: Logger;

  /**
   * Internal native WebSocket object.
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

  protected _remoteHost: Host;
  protected _remotePort: Port;
  protected _localHost?: Host;
  protected _localPort?: Port;
  protected certDERs: Array<Uint8Array> = [];
  protected caDERs: Array<Uint8Array> = [];
  protected remoteCertDERs: Array<Uint8Array> = [];

  /**
   * Secure connection establishment.
   * This can resolve or reject.
   * Will resolve after connection has established and peer certs have been validated.
   * Rejections cascade down to `secureEstablishedP` and `closedP`.
   */
  protected secureEstablished = false;
  protected secureEstablishedP: Promise<void>;
  protected resolveSecureEstablishedP: () => void;
  protected rejectSecureEstablishedP: (reason?: any) => void;

  protected socketLocallyClosed: boolean = false;
  protected closeSocket: (errorCode?: number, reason?: string) => void;
  /**
   * Connection closed promise.
   * This can resolve or reject.
   */
  public readonly closedP: Promise<void>;
  protected resolveClosedP: () => void;

  /**
   * This stores the last dispatched error.
   * If no error has occurred, it will be `null`.
   */
  protected errorLast:
    | errors.ErrorWebSocketConnectionLocal<unknown>
    | errors.ErrorWebSocketConnectionPeer<unknown>
    | errors.ErrorWebSocketConnectionKeepAliveTimeOut<unknown>
    | errors.ErrorWebSocketConnectionInternal<unknown>
    | null = null;

  protected handleEventWebSocketConnectionError = (
    evt: events.EventWebSocketConnectionError,
  ) => {
    const error = evt.detail;
    this.errorLast = error;
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
    // If the error is an internal error, throw it to become `EventError`
    // By default this will become an uncaught exception
    // Cannot attempt to close the connection, because an internal error is unrecoverable
    if (error instanceof errors.ErrorWebSocketConnectionInternal) {
      // Use `EventError` to deal with this
      throw error;
    }
    this.dispatchEvent(
      new events.EventWebSocketConnectionClose({
        detail: error,
      }),
    );
  };

  protected handleEventWebSocketConnectionClose = async (
    evt: events.EventWebSocketConnectionClose,
  ) => {
    const error = evt.detail;
    if (!this.secureEstablished) {
      this.rejectSecureEstablishedP(error);
    }
    if (this[startStop.running] && this[startStop.status] !== 'stopping') {
      // Failing to force stop is a software error
      await this.stop({
        force: true,
      });
    }
  };

  protected handleEventWebSocketStream = (evt: EventAll) => {
    if (evt.detail instanceof AbstractEvent) {
      this.dispatchEvent(evt.detail.clone());
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

  protected handleSocketMessage = async (
    data: ws.RawData,
    isBinary: boolean,
  ) => {
    if (!isBinary || data instanceof Array) {
      const reason = "WebSocket received data received that wasn't binary";
      this.dispatchEvent(
        new events.EventWebSocketConnectionError({
          detail: new errors.ErrorWebSocketConnectionLocal(reason, {
            cause: new errors.ErrorWebSocketUndefinedBehaviour(),
            data: {
              errorCode: utils.ConnectionErrorCode.InternalServerError,
              reason,
            },
          }),
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
      const reason = 'Parsing streamId failed';
      this.dispatchEvent(
        new events.EventWebSocketConnectionError({
          detail: new errors.ErrorWebSocketConnectionLocal(reason, {
            cause: e,
            data: {
              errorCode: utils.ConnectionErrorCode.InternalServerError,
              reason,
            },
          }),
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
    if (this.socketLocallyClosed) {
      return;
    }
    // No need to close socket, already closed on receiving event
    const e_ = new errors.ErrorWebSocketConnectionPeer(
      `Peer closed with code ${errorCode}`,
      {
        data: {
          errorCode,
          reason: reason.toString('utf-8'),
        },
      },
    );
    this.dispatchEvent(
      new events.EventWebSocketConnectionError({
        detail: e_,
      }),
    );
  };

  protected handleSocketError = (err: Error) => {
    const errorCode = utils.ConnectionErrorCode.InternalServerError;
    const reason = 'An error occurred on the underlying WebSocket instance';
    this.closeSocket(errorCode, reason);
    const e_ = new errors.ErrorWebSocketConnectionInternal(reason, {
      cause: err,
      data: {
        errorCode,
        reason,
      },
    });
    this.dispatchEvent(
      new events.EventWebSocketConnectionError({
        detail: e_,
      }),
    );
  };

  /**
   * Gets an array of local certificates in DER format starting on the leaf.
   */
  public getLocalCertsChain(): Array<Uint8Array> {
    return this.certDERs;
  }

  /**
   * Gets an array of CA certificates in DER format starting on the leaf.
   */
  public getLocalCACertsChain(): Array<Uint8Array> {
    return this.caDERs;
  }

  /**
   * Gets an array of peer certificates in DER format starting on the leaf.
   */
  public getRemoteCertsChain(): Array<Uint8Array> {
    return this.remoteCertDERs;
  }

  /**
   * Gets the connection metadata.
   */
  @startStop.ready(new errors.ErrorWebSocketConnectionNotRunning())
  public meta(): ConnectionMetadata {
    return {
      localHost: this._localHost,
      localPort: this._localPort,
      remoteHost: this._remoteHost,
      remotePort: this._remotePort,
      localCACertsChain: this.caDERs,
      localCertsChain: this.certDERs,
      remoteCertsChain: this.remoteCertDERs,
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
      this._remoteHost = meta.remoteHost as Host;
      this._remotePort = meta.remotePort as Port;
      this._localHost = meta.localHost as Host | undefined;
      this._localPort = meta.localPort as Port | undefined;
      this.caDERs = meta.localCACertsChain;
      this.certDERs = meta.localCertsChain;
      this.remoteCertDERs = meta.remoteCertsChain;
    }

    const {
      p: secureEstablishedP,
      resolveP: resolveSecureEstablishedP,
      rejectP: rejectSecureEstablishedP,
    } = utils.promise();
    this.secureEstablishedP = secureEstablishedP;
    this.resolveSecureEstablishedP = () => {
      // This is an idempotent mutation
      this.secureEstablished = true;
      resolveSecureEstablishedP();
    };
    this.rejectSecureEstablishedP = rejectSecureEstablishedP;

    const { p: closedP, resolveP: resolveClosedP } = utils.promise<void>();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;

    this.closeSocket = (errorCode, reason) => {
      this.socketLocallyClosed = true;
      this.socket.close(errorCode, reason);
    };
  }

  /**
   * The host of the peer.
   */
  public get remoteHost(): Host {
    return this._remoteHost;
  }

  /**
   * The port of the peer.
   */
  public get remotePort(): Port {
    return this._remotePort;
  }

  /**
   * The local host of the socket.
   */
  public get localHost(): Host | undefined {
    return this._localHost;
  }

  /**
   * The local port of the socket.
   */
  public get localPort(): Port | undefined {
    return this._localPort;
  }

  /**
   * Whether the underlying WebSocket has been closed.
   */
  public get closed() {
    return this.socket.readyState === ws.CLOSED;
  }

  /**
   * Start the connection.
   * @param ctx
   * @internal
   */
  public start(ctx?: Partial<ContextTimedInput>): PromiseCancellable<void>;
  @timedCancellable(
    true,
    connectTimeoutTime,
    errors.ErrorWebSocketConnectionStartTimeOut,
  )
  public async start(@context ctx: ContextTimed): Promise<void> {
    this.logger.info(`Start ${this.constructor.name}`);
    if (this.socket.readyState === ws.CLOSED) {
      throw new errors.ErrorWebSocketConnectionClosed();
    }
    // Are we supposed to throw?
    // It depends, if the connection start is aborted
    // In a way, it makes sense for it be thrown
    // It doesn't just simply complete
    ctx.signal.throwIfAborted();
    const { p: abortP, rejectP: rejectAbortP } = utils.promise<never>();
    const abortHandler = () => {
      rejectAbortP(ctx.signal.reason);
    };
    ctx.signal.addEventListener('abort', abortHandler);
    this.addEventListener(
      events.EventWebSocketConnectionError.name,
      this.handleEventWebSocketConnectionError,
    );
    this.addEventListener(
      events.EventWebSocketConnectionClose.name,
      this.handleEventWebSocketConnectionClose,
      { once: true },
    );

    // If the socket is already open, then the it is already secure and established by the WebSocketServer
    if (this.socket.readyState === ws.OPEN) {
      this.resolveSecureEstablishedP();
    }
    // Handle connection failure - Dispatch ConnectionError -> ConnectionClose -> rejectSecureEstablishedP
    const openErrorHandler = (e) => {
      let e_: errors.ErrorWebSocketConnection<any>;
      let reason: string;
      let errorCode: number;
      switch (e.code) {
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
          errorCode = utils.ConnectionErrorCode.TLSHandshake;
          reason =
            "WebSocket could not open due to failure to verify a peer's TLS certificate";
          e_ = new errors.ErrorWebSocketConnectionLocalTLS(reason, {
            cause: e,
            data: {
              errorCode,
              reason,
            },
          });
          break;
        case 'ECONNRESET':
          reason = 'WebSocket could not open due to socket closure by peer';
          (errorCode = utils.ConnectionErrorCode.AbnormalClosure),
            (e_ = new errors.ErrorWebSocketConnectionPeer(reason, {
              cause: e,
              data: {
                errorCode,
                reason,
              },
            }));
          break;
        default:
          reason = 'WebSocket could not open due to internal error';
          (errorCode = utils.ConnectionErrorCode.InternalServerError),
            (e_ = new errors.ErrorWebSocketConnectionLocal(reason, {
              cause: e,
              data: {
                errorCode,
                reason,
              },
            }));
          break;
      }
      this.closeSocket(errorCode, reason);
      this.dispatchEvent(
        new events.EventWebSocketConnectionError({
          detail: e_,
        }),
      );
    };
    this.socket.once('error', openErrorHandler);
    const openHandler = () => {
      this.resolveSecureEstablishedP();
    };
    this.socket.once('open', openHandler);
    // This will always happen, no need to remove the handler
    this.socket.once('close', this.handleSocketClose);

    if (this.type === 'client') {
      this.socket.once('upgrade', async (request) => {
        const tlsSocket = request.socket as TLSSocket;
        const peerCert = tlsSocket.getPeerCertificate(true);
        const peerCertChain = utils.toPeerCertChain(peerCert);
        const localCertChain = utils
          .collectPEMs(this.config.cert)
          .map(utils.pemToDER);
        const ca = utils.collectPEMs(this.config.ca).map(utils.pemToDER);
        try {
          if (this.config.verifyPeer && this.config.verifyCallback != null) {
            await this.config.verifyCallback?.(peerCertChain, ca);
          }
          this._localHost = request.connection.localAddress as Host;
          this._localPort = request.connection.localPort as Port;
          this._remoteHost = request.connection.remoteAddress as Host;
          this._remotePort = request.connection.remotePort as Port;
          this.caDERs = ca;
          this.certDERs = localCertChain;
          this.remoteCertDERs = peerCertChain;
        } catch (e) {
          const errorCode = utils.ConnectionErrorCode.TLSHandshake;
          const reason =
            'Failed connection due to custom verification callback';
          // Request.destroy() will make the socket dispatch a 'close' event,
          // so I'm setting socketLocallyClosed to true, as that is what is happening.
          this.socketLocallyClosed = true;
          request.destroy(e);
          const e_ = new errors.ErrorWebSocketConnectionLocalTLS(reason, {
            cause: e,
            data: {
              errorCode,
              reason,
            },
          });
          this.dispatchEvent(
            new events.EventWebSocketConnectionError({
              detail: e_,
            }),
          );
        }
      });
    }

    // Wait for open
    // This should only reject with ErrorWebSocketConnectionLocal.
    // This can either be from a ws.WebSocket error, or abort signal, or TLS handshake error
    try {
      await Promise.race([this.secureEstablishedP, abortP]);
    } catch (e) {
      // This happens if a timeout occurs.
      if (ctx.signal.aborted) {
        const errorCode = utils.ConnectionErrorCode.ProtocolError;
        const reason =
          'Failed to start WebSocket connection due to start timeout';
        this.closeSocket(errorCode, reason);
        const e_ = new errors.ErrorWebSocketConnectionLocal(reason, {
          cause: e,
          data: {
            errorCode,
            reason,
          },
        });
        this.dispatchEvent(
          new events.EventWebSocketConnectionError({
            detail: e_,
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

    if (this.config.keepAliveIntervalTime != null) {
      this.startKeepAliveIntervalTimer(this.config.keepAliveIntervalTime);
    }
    if (this.config.keepAliveTimeoutTime != null) {
      this.setKeepAliveTimeoutTimer();
    }

    this.logger.info(`Started ${this.constructor.name}`);
  }

  /**
   * Creates a new bidirectional WebSocketStream.
   */
  @startStop.ready(new errors.ErrorWebSocketConnectionNotRunning())
  public async newStream(): Promise<WebSocketStream> {
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
   */
  private async send(data: Uint8Array | Array<Uint8Array>) {
    if (this.socket.readyState !== ws.OPEN) {
      this.logger.debug('a message was dropped because the socket is not open');
      return;
    }

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
      const errorCode = utils.ConnectionErrorCode.InternalServerError;
      const reason =
        'Connection was unable to send data due to internal WebSocket error';
      this.closeSocket(errorCode, reason);
      const e_ = new errors.ErrorWebSocketConnectionLocal(reason, {
        cause: new errors.ErrorWebSocketServerInternal(reason, {
          cause: err,
        }),
        data: {
          errorCode,
          reason,
        },
      });
      this.dispatchEvent(
        new events.EventWebSocketConnectionError({
          detail: e_,
        }),
      );
      // Will not wait for close, happens asynchronously
    }
  }

  /**
   * Stops WebSocketConnection
   * @param opts
   * @param opts.errorCode - The error code to send to the peer on closing
   * @param opts.errorMessage - The error message to send to the peer on closing
   * @param opts.force - When force is false, the returned promise will wait for all streams to close naturally before resolving.
   */
  public async stop({
    errorCode = utils.ConnectionErrorCode.Normal,
    reason = '',
    force = true,
  }: {
    errorCode?: number;
    reason?: string;
    force?: boolean;
  } = {}) {
    this.logger.info(`Stop ${this.constructor.name}`);
    this.stopKeepAliveIntervalTimer();
    this.stopKeepAliveTimeoutTimer();
    if (
      this.socket.readyState !== ws.CLOSING &&
      this.socket.readyState !== ws.CLOSED
    ) {
      this.closeSocket(errorCode, reason);
      const e = new errors.ErrorWebSocketConnectionLocal(
        `Locally closed with code ${errorCode}`,
        {
          data: {
            errorCode,
            reason,
          },
        },
      );
      this.dispatchEvent(
        new events.EventWebSocketConnectionError({ detail: e }),
      );
    }

    // Cleaning up existing streams
    const streamsDestroyP: Array<Promise<void>> = [];
    this.logger.debug('triggering stream destruction');
    for (const stream of this.streamMap.values()) {
      streamsDestroyP.push(
        stream.stop({
          reason: this.errorLast,
          force:
            force ||
            this.socket.readyState === ws.CLOSED ||
            this.socket.readyState === ws.CLOSING,
        }),
      );
    }
    await Promise.all(streamsDestroyP);
    // Waiting for `closedP` to resolve
    await this.closedP;
    // Remove event listeners before possible event dispatching to avoid recursion
    this.removeEventListener(
      events.EventWebSocketConnectionError.name,
      this.handleEventWebSocketConnectionError,
    );
    this.removeEventListener(
      events.EventWebSocketConnectionClose.name,
      this.handleEventWebSocketConnectionClose,
    );
    this.socket.off('message', this.handleSocketMessage);
    this.socket.off('ping', this.handleSocketPing);
    this.socket.off('pong', this.handleSocketPong);
    this.socket.off('error', this.handleSocketError);

    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  protected setKeepAliveTimeoutTimer(): void {
    const logger = this.logger.getChild('timer');
    const timeout = this.config.keepAliveTimeoutTime;
    const keepAliveTimeOutHandler = async (signal: AbortSignal) => {
      if (signal.aborted) return;
      if (this.socket.readyState === ws.CLOSED) {
        this.resolveClosedP();
        return;
      }
      this.dispatchEvent(
        new events.EventWebSocketConnectionError({
          detail: new errors.ErrorWebSocketConnectionKeepAliveTimeOut(),
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
      this.keepAliveTimeOutTimer?.cancel();
      this.keepAliveTimeOutTimer = new Timer({
        delay: timeout,
        handler: keepAliveTimeOutHandler,
      });
    }
  }

  /**
   * Stops the keep alive interval timer
   */
  protected stopKeepAliveTimeoutTimer(): void {
    this.keepAliveTimeOutTimer?.cancel();
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
    this.keepAliveIntervalTimer?.cancel();
  }
}

export default WebSocketConnection;
