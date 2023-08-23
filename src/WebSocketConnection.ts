import { PromiseCancellable } from '@matrixai/async-cancellable';
import { startStop } from '@matrixai/async-init';
import { ContextTimed, ContextTimedInput } from '@matrixai/contexts';
import { Lock } from '@matrixai/async-locks';
import { context, timedCancellable } from '@matrixai/contexts/dist/decorators';
import Logger from '@matrixai/logger';
import * as ws from 'ws';
import { Host, RemoteInfo, StreamId, VerifyCallback, WebSocketConfig } from './types';
import WebSocketClient from './WebSocketClient';
import WebSocketServer from './WebSocketServer';
import WebSocketStream from './WebSocketStream';
import Counter from 'resource-counter';
import * as errors from './errors';
import { promise } from './utils';
import { Timer } from '@matrixai/timer';
import * as events from './events';
import { ready } from '@matrixai/async-init/dist/CreateDestroyStartStop';

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
  protected streamIdClientBidi: StreamId = 0b00 as StreamId;

   /**
    * Server initiated bidirectional stream starts at 1.
    * Increment by 4 to get the next ID.
    */
  protected streamIdServerBidi: StreamId = 0b01 as StreamId;

   /**
    * Client initiated unidirectional stream starts at 2.
    * Increment by 4 to get the next ID.
    * Currently unsupported.
    */
  protected _streamIdClientUni: StreamId = 0b10 as StreamId;

   /**
    * Server initiated unidirectional stream starts at 3.
    * Increment by 4 to get the next ID.
    * Currently unsupported.
    */
  protected _streamIdServerUni: StreamId = 0b11 as StreamId;

  protected keepAliveTimeOutTimer?: Timer;
  protected keepAliveIntervalTimer?: Timer;

  protected client?: WebSocketClient;
  protected server?: WebSocketServer;
  protected logger: Logger;
  protected _remoteHost: Host;

  /**
   * Connection closed promise.
   * This can resolve or reject.
   */
  protected closedP: Promise<void>;

  protected resolveClosedP: () => void;
  protected rejectClosedP: (reason?: any) => void;

  protected messageHandler = (data: ws.RawData, isBinary: boolean) => {
    if (!isBinary || data instanceof Array) {
      this.dispatchEvent(
        new events.WebSocketConnectionErrorEvent({
          detail: new errors.ErrorWebSocketUndefinedBehaviour()
        })
      );
      return;
    }
  }

  public static createWebSocketConnection(
    args: {
      type: 'client';
      connectionId: number;
      remoteInfo: RemoteInfo;
      config: WebSocketConfig;
      socket: ws.WebSocket;
      server?: undefined
      client?: WebSocketClient;
      verifyCallback?: VerifyCallback;
      logger?: Logger;
    } | {
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
  @timedCancellable(
    true,
    Infinity,
    errors.ErrorWebSocketConnectionStartTimeOut
  )
  public static async createWebSocketConnection(
    args: {
      type: 'client';
      connectionId: number;
      remoteInfo: RemoteInfo;
      config: WebSocketConfig;
      socket: ws.WebSocket;
      server?: undefined
      client?: WebSocketClient;
      verifyCallback?: VerifyCallback;
      logger?: Logger;
    } | {
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
    }
    ctx.signal.addEventListener('abort', abortHandler);
    const connection = new this(args);
    try {
      await Promise.race([
        connection.start(),
        abortProm.p,
      ]);
    }
    catch (e) {
      await connection.stop({ force: true });
      throw e;
    }
    finally {
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
  }: {
    type: 'client';
    connectionId: number;
    remoteInfo: RemoteInfo;
    config: WebSocketConfig;
    socket: ws.WebSocket;
    server?: undefined
    client?: WebSocketClient;
    verifyCallback?: VerifyCallback;
    logger?: Logger;
  } | {
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
    this.server = server;
    this.client = client;
    this._remoteHost = remoteInfo.host;

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
    await connectProm;
    this.socket.off('open', openHandler);

    // Set the connection up
    if (this.type === 'server') {
      this.server!.connectionMap.set(this.connectionId, this);
    }

    this.socket.once('close', () => {
      this.resolveClosedP();
      if (this[startStop.running] && this[startStop.status] !== 'stopping') {
        void this.stop({ force: true });
      }
    });
    this.socket.on('ping', () => {
      this.socket.pong();
    });
    this.socket.on('pong', () => {
      this.setKeepAliveTimeoutTimer();
    });
    this.socket.on('message', this.messageHandler);

    this.logger.info(`Started ${this.constructor.name}`);
  }

  @ready(new errors.ErrorWebSocketConnectionNotRunning())
  public async streamNew(streamType: 'bidi' = 'bidi'): Promise<WebSocketStream> {
    return await this.streamIdLock.withF(async () => {
      let streamId: StreamId;
      if (this.type === 'client' && streamType === 'bidi') {
        streamId = this.streamIdClientBidi;
      } else if (this.type === 'server' && streamType === 'bidi') {
        streamId = this.streamIdServerBidi;
      }
      const wsStream = await WebSocketStream.createWebSocketStream({
        streamId: streamId!,
        connection: this,
        logger: this.logger.getChild(`${WebSocketStream.name} ${streamId!}`),
      });
      // Ok the stream is opened and working
      if (this.type === 'client' && streamType === 'bidi') {
        this.streamIdClientBidi = (this.streamIdClientBidi + 4) as StreamId;
      } else if (this.type === 'server' && streamType === 'bidi') {
        this.streamIdServerBidi = (this.streamIdServerBidi + 4) as StreamId;
      }
      return wsStream;
    });
  }

  public async stop({
    force = false
  } : {
    force: boolean
  }) {
    this.logger.info(`Stop ${this.constructor.name}`);
    // Cleaning up existing streams
    // ...
    this.logger.debug('triggering stream destruction');
    this.logger.debug('waiting for streams to destroy');
    this.logger.debug('streams destroyed');
    this.stopKeepAliveIntervalTimer();

    if (this.socket.readyState === ws.CLOSED) {
      this.resolveClosedP();
    }
    else {
      this.socket.close();
    }
    await this.closedP;
    this.logger.debug('closedP');
    this.keepAliveTimeOutTimer?.cancel(timerCleanupReasonSymbol);

    if (this.type === 'server') {
      this.server!.connectionMap.delete(this.connectionId);
      this.server!.connectionIdCounter.deallocate(this.connectionId);
    }

    this.dispatchEvent(new events.WebSocketConnectionStopEvent());
    this.logger.info(`Stopped ${this.constructor.name}`);
  }

  protected setKeepAliveTimeoutTimer(): void {
    const logger = this.logger.getChild('timer');
    const timeout = this.config.keepAliveTimeoutTime;
    const keepAliveTimeOutHandler = () => {
      this.dispatchEvent(new events.WebSocketConnectionErrorEvent({
        detail: new errors.ErrorWebSocketConnectionKeepAliveTimeOut(),
      }));
      if (this[startStop.running] && this[startStop.status] !== 'stopping') {
        void this.stop({ force: true });
      }
    };
    // If there was an existing timer, we cancel it and set a new one
    if (
      this.keepAliveTimeOutTimer != null &&
      this.keepAliveTimeOutTimer.status === null
    ) {
      logger.debug(`resetting timer with ${timeout} delay`);
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
