import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ContextTimed, ContextTimedInput } from '@matrixai/contexts';
import type {
  Host,
  PromiseDeconstructed,
  RemoteInfo,
  StreamId,
  VerifyCallback,
  WebSocketConfig,
} from './types';
import type WebSocketClient from './WebSocketClient';
import type WebSocketServer from './WebSocketServer';
import { startStop } from '@matrixai/async-init';
import { Lock } from '@matrixai/async-locks';
import { context, timedCancellable } from '@matrixai/contexts/dist/decorators';
import Logger from '@matrixai/logger';
import * as ws from 'ws';
import { Timer } from '@matrixai/timer';
import { ready } from '@matrixai/async-init/dist/CreateDestroyStartStop';
import WebSocketStream from './WebSocketStream';
import * as errors from './errors';
import { fromStreamId, promise, toStreamId } from './utils';
import * as events from './events';
import { Counter } from 'resource-counter';
import WebSocketConnectionMap from './WebSocketConnectionMap';
import { DetailedPeerCertificate, TLSSocket } from 'tls';

const timerCleanupReasonSymbol = Symbol('timerCleanupReasonSymbol');

/**
 * Think of this as equivalent to `net.Socket`.
 * This is one-to-one with the ws.WebSocket.
 * Errors here are emitted to the connection only.
 * Not to the server.
 *
 * Events (events are executed post-facto):
 * - connectionStream
 * - connectionStop
 * - connectionError - can occur due to a timeout too
 * - streamDestroy
 */
interface WebSocketConnection extends startStop.StartStop {}
@startStop.StartStop()
class WebSocketConnection extends EventTarget {
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

  /**
   * Client initiated unidirectional stream starts at 2.
   * Increment by 4 to get the next ID.
   * Currently unsupported.
   */
  protected _streamIdClientUni: StreamId = 0b10n as StreamId;

  /**
   * Server initiated unidirectional stream starts at 3.
   * Increment by 4 to get the next ID.
   * Currently unsupported.
   */
  protected _streamIdServerUni: StreamId = 0b11n as StreamId;

  protected keepAliveTimeOutTimer?: Timer;
  protected keepAliveIntervalTimer?: Timer;

  protected parentInstance: {
    connectionMap: WebSocketConnectionMap
  };
  protected logger: Logger;
  protected _remoteHost: Host;

  /**
   * Bubble up stream destroy event
   */
  protected handleWebSocketStreamDestroyEvent = () => {
    this.dispatchEvent(new events.WebSocketStreamDestroyEvent());
  };

  /**
   * Connection closed promise.
   * This can resolve or reject.
   */
  protected closedP: Promise<void>;

  protected resolveClosedP: () => void;
  protected rejectClosedP: (reason?: any) => void;

  protected verifyCallback: ((peerCert: DetailedPeerCertificate) => Promise<void>) | undefined;

  protected messageHandler = async (data: ws.RawData, isBinary: boolean) => {
    if (!isBinary || data instanceof Array) {
      this.dispatchEvent(
        new events.WebSocketConnectionErrorEvent({
          detail: new errors.ErrorWebSocketUndefinedBehaviour(),
        }),
      );
      return;
    }
    let message: Uint8Array =
      data instanceof ArrayBuffer ? new Uint8Array(data) : data;

    const { data: streamId, remainder } = toStreamId(message);
    message = remainder;

    let stream = this.streamMap.get(streamId);
    if (stream == null) {
      stream = await WebSocketStream.createWebSocketStream({
        connection: this,
        streamId,
        logger: this.logger.getChild(`${WebSocketStream.name} ${streamId!}`),
      });
      stream.addEventListener(
        'streamDestroy',
        this.handleWebSocketStreamDestroyEvent,
        { once: true },
      );
      this.dispatchEvent(
        new events.WebSocketConnectionStreamEvent({
          detail: stream,
        }),
      );
    }

    stream!.streamRecv(message);
  };

  protected pingHandler = () => {
    this.socket.pong();
  };

  protected pongHandler = () => {
    this.setKeepAliveTimeoutTimer();
  };

  public static createWebSocketConnection(
    args:
      | {
          type: 'client';
          connectionId: number;
          remoteInfo: RemoteInfo;
          config: WebSocketConfig;
          socket: ws.WebSocket;
          server?: undefined;
          client?: WebSocketClient;
          verifyCallback?: VerifyCallback;
          logger?: Logger;
        }
      | {
          type: 'server';
          connectionId: number;
          remoteInfo: RemoteInfo;
          config: WebSocketConfig;
          socket: ws.WebSocket;
          server?: WebSocketServer;
          client?: undefined;
          verifyCallback?: undefined;
          logger?: Logger;
        },
    ctx?: Partial<ContextTimedInput>,
  ): PromiseCancellable<WebSocketConnection>;
  @timedCancellable(true, Infinity, errors.ErrorWebSocketConnectionStartTimeOut)
  public static async createWebSocketConnection(
    args:
      | {
          type: 'client';
          connectionId: number;
          remoteInfo: RemoteInfo;
          config: WebSocketConfig;
          socket: ws.WebSocket;
          server?: undefined;
          client?: WebSocketClient;
          verifyCallback?: VerifyCallback;
          logger?: Logger;
        }
      | {
          type: 'server';
          connectionId: number;
          remoteInfo: RemoteInfo;
          config: WebSocketConfig;
          socket: ws.WebSocket;
          server?: WebSocketServer;
          client?: undefined;
          verifyCallback?: undefined;
          logger?: Logger;
        },
    @context ctx: ContextTimed,
  ): Promise<WebSocketConnection> {
    // Setting up abort/cancellation logic
    const abortProm = promise<never>();
    const abortHandler = () => {
      abortProm.rejectP(ctx.signal.reason);
    };
    ctx.signal.addEventListener('abort', abortHandler);
    const connection = new this(args);
    try {
      await Promise.race([connection.start(), abortProm.p]);
    } catch (e) {
      await connection.stop({ force: true });
      throw e;
    } finally {
      ctx.signal.removeEventListener('abort', abortHandler);
    }
    if (connection.config.keepAliveIntervalTime != null) {
      connection.startKeepAliveIntervalTimer(
        connection.config.keepAliveIntervalTime,
      );
    }
    return connection;
  }
  public constructor({
    type,
    connectionId,
    remoteInfo,
    config,
    socket,
    server,
    client,
    verifyCallback,
    logger,
  }:
    | {
        type: 'client';
        connectionId: number;
        remoteInfo: RemoteInfo;
        config: WebSocketConfig;
        socket: ws.WebSocket;
        server?: undefined;
        client?: WebSocketClient;
        verifyCallback?: VerifyCallback;
        logger?: Logger;
      }
    | {
        type: 'server';
        connectionId: number;
        remoteInfo: RemoteInfo;
        config: WebSocketConfig;
        socket: ws.WebSocket;
        server?: WebSocketServer;
        client?: undefined;
        verifyCallback?: undefined;
        logger?: Logger;
      }) {
    super();
    this.logger = logger ?? new Logger(`${this.constructor.name}`);
    this.connectionId = connectionId;
    this.socket = socket;
    this.config = config;
    this.type = type;
    this.parentInstance = server ?? client!;
    this._remoteHost = remoteInfo.host;
    this.verifyCallback = verifyCallback;

    const {
      p: closedP,
      resolveP: resolveClosedP,
      rejectP: rejectClosedP,
    } = promise<void>();
    this.closedP = closedP;
    this.resolveClosedP = resolveClosedP;
    this.rejectClosedP = rejectClosedP;
  }
  public async start(): Promise<void> {
    this.logger.info(`Start ${this.constructor.name}`);
    const promises: Array<Promise<any>> = [];

    const connectProm = promise<void>();

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
      const authenticateProm = promise<{
        localHost: string;
        localPort: number;
        remoteHost: string;
        remotePort: number;
        peerCert: DetailedPeerCertificate;
      }>();
      this.socket.once('upgrade', async (request) => {
        const tlsSocket = request.socket as TLSSocket;
        const peerCert = tlsSocket.getPeerCertificate(true);
        try {
          if (this.verifyCallback != null) {
            await this.verifyCallback(peerCert);
          }
          authenticateProm.resolveP({
            localHost: request.connection.localAddress ?? '',
            localPort: request.connection.localPort ?? 0,
            remoteHost: request.connection.remoteAddress ?? '',
            remotePort: request.connection.remotePort ?? 0,
            peerCert,
          });
        }
        catch (e) {
          authenticateProm.rejectP(e);
        }
      });
      promises.push(authenticateProm.p);
    }

    // Wait for open
    try {
      await Promise.all(promises);
    }
    catch (e) {
      this.socket.removeAllListeners('error');
      this.socket.removeAllListeners('upgrade');
      this.socket.removeAllListeners('open');
      // Close the ws if it's open at this stage
      this.socket.terminate();
      throw e;
    }
    finally {
      this.socket.removeAllListeners('upgrade');
      this.socket.off('open', openHandler);
      this.socket.off('error', openErrorHandler);
    }

    // Set the connection up
    this.parentInstance.connectionMap.set(this.connectionId, this);

    this.socket.once('close', () => {
      this.resolveClosedP();
      if (this[startStop.running] && this[startStop.status] !== 'stopping') {
        void this.stop({ force: true });
      }
    });

    this.socket.on('message', this.messageHandler);
    this.socket.on('ping', this.pingHandler);
    this.socket.on('pong', this.pongHandler);

    this.logger.info(`Started ${this.constructor.name}`);
  }

  @ready(new errors.ErrorWebSocketConnectionNotRunning())
  public async streamNew(
    streamType: 'bidi' = 'bidi',
  ): Promise<WebSocketStream> {
    return await this.streamIdLock.withF(async () => {
      let streamId: StreamId;
      if (this.type === 'client' && streamType === 'bidi') {
        streamId = this.streamIdClientBidi;
      } else if (this.type === 'server' && streamType === 'bidi') {
        streamId = this.streamIdServerBidi;
      }
      const stream = await WebSocketStream.createWebSocketStream({
        streamId: streamId!,
        connection: this,
        logger: this.logger.getChild(`${WebSocketStream.name} ${streamId!}`),
      });
      stream.addEventListener(
        'streamDestroy',
        this.handleWebSocketStreamDestroyEvent,
        { once: true },
      );
      // Ok the stream is opened and working
      if (this.type === 'client' && streamType === 'bidi') {
        this.streamIdClientBidi = (this.streamIdClientBidi + 4n) as StreamId;
      } else if (this.type === 'server' && streamType === 'bidi') {
        this.streamIdServerBidi = (this.streamIdServerBidi + 4n) as StreamId;
      }
      return stream;
    });
  }

  public async streamSend(streamId: StreamId, data: Uint8Array) {
    const sendProm = promise<void>();

    const encodedStreamId = fromStreamId(streamId);
    const array = new Uint8Array(encodedStreamId.length + data.length);
    array.set(encodedStreamId, 0);
    array.set(data, encodedStreamId.length);
    if (data != null) {
      array.set(data, encodedStreamId.length);
    }

    this.socket.send(array, (err) => {
      if (err == null) sendProm.resolveP();
      else sendProm.rejectP(err);
    });

    await sendProm.p;
  }

  public async stop({ force = false }: { force: boolean }) {
    this.logger.info(`Stop ${this.constructor.name}`);
    // Cleaning up existing streams
    const streamsDestroyP: Array<Promise<void>> = [];
    this.logger.debug('triggering stream destruction');
    for (const stream of this.streamMap.values()) {
      streamsDestroyP.push(stream.destroy());
    }
    this.logger.debug('waiting for streams to destroy');
    await Promise.all(streamsDestroyP);
    this.logger.debug('streams destroyed');
    this.stopKeepAliveIntervalTimer();

    // Socket Cleanup
    if (this.socket.readyState === ws.CLOSED) {
      this.resolveClosedP();
    } else {
      this.socket.close();
    }
    await this.closedP;
    this.logger.debug('closedP');
    this.socket.off('message', this.messageHandler);
    this.socket.off('ping', this.pingHandler);
    this.socket.off('pong', this.pongHandler);
    this.keepAliveTimeOutTimer?.cancel(timerCleanupReasonSymbol);

    if (this.type === 'server') {
      this.parentInstance!.connectionMap.delete(this.connectionId);
    }

    this.dispatchEvent(new events.WebSocketConnectionStopEvent());
    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  protected setKeepAliveTimeoutTimer(): void {
    const logger = this.logger.getChild('timer');
    const timeout = this.config.keepAliveTimeoutTime;
    const keepAliveTimeOutHandler = () => {
      this.dispatchEvent(
        new events.WebSocketConnectionErrorEvent({
          detail: new errors.ErrorWebSocketConnectionKeepAliveTimeOut(),
        }),
      );
      if (this[startStop.running] && this[startStop.status] !== 'stopping') {
        void this.stop({ force: true });
      }
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
