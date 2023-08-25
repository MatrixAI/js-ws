import type { DetailedPeerCertificate, TLSSocket } from 'tls';
import type { ContextTimed } from '@matrixai/contexts';
import type { VerifyCallback } from './types';
import { createDestroy } from '@matrixai/async-init';
import Logger from '@matrixai/logger';
import WebSocket from 'ws';
import { Validator } from 'ip-num';
import { Timer } from '@matrixai/timer';
import WebSocketStream from './WebSocketStream';
import * as errors from './errors';
import { promise } from './utils';
import WebSocketConnection from './WebSocketConnection';
import Counter from 'resource-counter';

interface WebSocketClient extends createDestroy.CreateDestroy {}
@createDestroy.CreateDestroy()
class WebSocketClient {
  /**
   * @param obj
   * @param obj.host - Target host address to connect to
   * @param obj.port - Target port to connect to
   * @param obj.expectedNodeIds - Expected NodeIds you are trying to connect to. Will validate the cert chain of the
   * sever. If none of these NodeIDs are found the connection will be rejected.
   * @param obj.connectionTimeoutTime - Timeout time used when attempting the connection.
   * Default is Infinity milliseconds.
   * @param obj.pingIntervalTime - Time between pings for checking connection health and keep alive.
   * Default is 1,000 milliseconds.
   * @param obj.pingTimeoutTimeTime - Time before connection is cleaned up after no ping responses.
   * Default is 10,000 milliseconds.
   * @param obj.logger
   */
  static async createWebSocketClient({
    host,
    port,
    connectionTimeoutTime = Infinity,
    pingIntervalTime = 1_000,
    pingTimeoutTimeTime = 10_000,
    logger = new Logger(this.name),
    verifyCallback,
  }: {
    host: string;
    port: number;
    connectionTimeoutTime?: number;
    pingIntervalTime?: number;
    pingTimeoutTimeTime?: number;
    logger?: Logger;
    verifyCallback?: VerifyCallback;
  }): Promise<WebSocketClient> {
    logger.info(`Create ${this.name} to ${host}:${port}`);
    const clientClient = new this(
      logger,
      host,
      port,
      connectionTimeoutTime,
      pingIntervalTime,
      pingTimeoutTimeTime,
      verifyCallback,
    );
    logger.info(`Created ${this.name}`);
    return clientClient;
  }

  protected host: string;

  public readonly connectionIdCounter = new Counter(0);
  public readonly connectionMap: Map<number, WebSocketConnection> = new Map();

  constructor(
    protected logger: Logger,
    host: string,
    protected port: number,
    protected connectionTimeoutTime: number,
    protected pingIntervalTime: number,
    protected pingTimeoutTimeTime: number,
    protected verifyCallback?: VerifyCallback,
  ) {
    if (Validator.isValidIPv4String(host)[0]) {
      this.host = host;
    } else if (Validator.isValidIPv6String(host)[0]) {
      this.host = `[${host}]`;
    } else {
      throw new errors.ErrorWebSocketClientInvalidHost();
    }
  }

  public async destroy(force: boolean = false) {
    this.logger.info(`Destroying ${this.constructor.name}`);
    if (force) {
      for (const activeConnection of this.activeConnections) {
        activeConnection.cancel(
          new errors.ErrorClientEndingConnections(
            'Destroying WebSocketClient',
          ),
        );
      }
    }
    for (const activeConnection of this.activeConnections) {
      // Ignore errors here, we only care that it finishes
      await activeConnection.endedProm.catch(() => {});
    }
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }

  @createDestroy.ready(new errors.ErrorWebSocketClientDestroyed())
  public async stopConnections() {
    for (const activeConnection of this.activeConnections) {
      activeConnection.cancel(
        new errors.ErrorClientEndingConnections(),
      );
    }
    for (const activeConnection of this.activeConnections) {
      // Ignore errors here, we only care that it finished
      await activeConnection.endedProm.catch(() => {});
    }
  }

  @createDestroy.ready(new errors.ErrorWebSocketClientDestroyed())
  public async startConnection(
    ctx: Partial<ContextTimed> = {},
  ): Promise<WebSocketStream> {
    // Setting up abort/cancellation logic
    const abortRaceProm = promise<never>();
    // Ignore unhandled rejection
    abortRaceProm.p.catch(() => {});
    const timer =
      ctx.timer ??
      new Timer({
        delay: this.connectionTimeoutTime,
      });
    void timer.then(
      () => {
        abortRaceProm.rejectP(
          new errors.ErrorClientConnectionTimedOut(),
        );
      },
      () => {}, // Ignore cancellation errors
    );
    const { signal } = ctx;
    let abortHandler: () => void | undefined;
    if (signal != null) {
      abortHandler = () => {
        abortRaceProm.rejectP(signal.reason);
      };
      if (signal.aborted) abortHandler();
      else signal.addEventListener('abort', abortHandler);
    }
    const cleanUp = () => {
      // Cancel timer if it was internally created
      if (ctx.timer == null) timer.cancel();
      signal?.removeEventListener('abort', abortHandler);
    };
    const address = `wss://${this.host}:${this.port}`;
    this.logger.info(`Connecting to ${address}`);
    const connectProm = promise<void>();
    const authenticateProm = promise<{
      localHost: string;
      localPort: number;
      remoteHost: string;
      remotePort: number;
      peerCert: DetailedPeerCertificate;
    }>();
    // Let ws handle authentication if no custom verify callback is provided.
    const ws = new WebSocket(address, {
      rejectUnauthorized: this.verifyCallback != null,
    });
    // Handle connection failure
    const openErrorHandler = (e) => {
      connectProm.rejectP(
        new errors.ErrorClientConnectionFailed(undefined, {
          cause: e,
        }),
      );
    };
    ws.once('error', openErrorHandler);
    // Authenticate server's certificate (this will be automatically done)
    ws.once('upgrade', async (request) => {
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
      } catch (e) {
        authenticateProm.rejectP(e);
      }
    });
    ws.once('open', () => {
      this.logger.info('starting connection');
      connectProm.resolveP();
    });
    const earlyCloseProm = promise();
    ws.once('close', () => {
      earlyCloseProm.resolveP();
    });
    // There are 3 resolve conditions here.
    //  1. Connection established and authenticated
    //  2. connection error or authentication failure
    //  3. connection timed out
    try {
      await Promise.race([
        abortRaceProm.p,
        await Promise.all([authenticateProm.p, connectProm.p]),
      ]);
    } catch (e) {
      // Clean up
      // unregister handlers
      ws.removeAllListeners('error');
      ws.removeAllListeners('upgrade');
      ws.removeAllListeners('open');
      // Close the ws if it's open at this stage
      ws.terminate();
      // Ensure the connection is removed from the active connection set before
      //  returning.
      await earlyCloseProm.p;
      throw e;
    } finally {
      cleanUp();
      // Cleaning up connection error
      ws.removeEventListener('error', openErrorHandler);
    }

    // Constructing the `ReadableWritablePair`, the lifecycle is handed off to
    //  the webSocketStream at this point.
    const webSocketStreamClient = WebSocketConnection.createWebSocketConnection(
      ws,
      this.pingIntervalTime,
      this.pingTimeoutTimeTime,
      {
        ...(await authenticateProm.p),
      },
      this.logger.getChild(WebSocketStream.name),
    );
    const abortStream = () => {
      webSocketStreamClient.cancel(
        new errors.ErrorClientStreamAborted(undefined, {
          cause: signal?.reason,
        }),
      );
    };
    // Setting up activeStream map lifecycle
    this.activeConnections.add(webSocketStreamClient);
    void webSocketStreamClient.endedProm
      // Ignore errors, we only care that it finished
      .catch(() => {})
      .finally(() => {
        this.activeConnections.delete(webSocketStreamClient);
        signal?.removeEventListener('abort', abortStream);
      });
    // Abort connection on signal
    if (signal?.aborted === true) abortStream();
    else signal?.addEventListener('abort', abortStream);
    return webSocketStreamClient;
  }
}

// This is the internal implementation of the client's stream pair.
export default WebSocketClient;
