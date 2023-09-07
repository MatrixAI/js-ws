import type { Host, Port, VerifyCallback, WebSocketConfig } from './types';
import type { AbstractEvent } from '@matrixai/events';
import { createDestroy } from '@matrixai/async-init';
import Logger from '@matrixai/logger';
import WebSocket from 'ws';
import { Validator } from 'ip-num';
import { EventAll, EventDefault } from '@matrixai/events';
import * as errors from './errors';
import WebSocketConnection from './WebSocketConnection';
import WebSocketConnectionMap from './WebSocketConnectionMap';
import { clientDefault } from './config';
import * as events from './events';

interface WebSocketClient extends createDestroy.CreateDestroy {}
/**
 * You must provide an error handler `addEventListener('error')`.
 * Otherwise, errors will just be ignored.
 *
 * Events:
 * - {@link events.EventWebSocketClientDestroy}
 * - {@link events.EventWebSocketClientDestroyed}
 * - {@link events.EventWebSocketClientError}
 * - {@link events.EventWebSocketConnectionStream}
 * - {@link events.EventWebSocketConnectionStart}
 * - {@link events.EventWebSocketConnectionStarted}
 * - {@link events.EventWebSocketConnectionStop}
 * - {@link events.EventWebSocketConnectionStopped}
 * - {@link events.EventWebSocketConnectionError} - can occur due to a timeout too
 * - {@link events.EventWebSocketStreamDestroy}
 * - {@link events.EventWebSocketStreamDestroyed}
 */
@createDestroy.CreateDestroy({
  eventDestroy: events.EventWebSocketClientDestroy,
  eventDestroyed: events.EventWebSocketClientDestroyed,
})
class WebSocketClient extends EventTarget {
  protected logger: Logger;

  protected _connection: WebSocketConnection;
  public readonly connectionMap: WebSocketConnectionMap =
    new WebSocketConnectionMap();

  protected address: string;

  protected handleEventWebSocketConnection = async (
    event_: EventAll<AbstractEvent> | AbstractEvent,
  ) => {
    let event: AbstractEvent;
    if (event_ instanceof EventAll) {
      event = event_.detail;
    } else {
      event = event_;
    }

    this.dispatchEvent(event.clone());

    if (event instanceof events.EventWebSocketConnectionStopped) {
      try {
        // Force destroy means don't destroy gracefully
        await this.destroy({
          force: true,
        });
      } catch (e) {
        this.dispatchEvent(
          new events.EventWebSocketClientError({
            detail: e.detail,
          }),
        );
      }
    } else if (event instanceof events.EventWebSocketConnectionError) {
      this.dispatchEvent(
        (event as events.EventWebSocketConnectionError).clone(),
      );
      try {
        // Force destroy means don't destroy gracefully
        await this.destroy({
          force: true,
        });
      } catch (e) {
        this.dispatchEvent(
          new events.EventWebSocketClientError({
            detail: e.detail,
          }),
        );
      }
    }
  };

  constructor({ address, logger }: { address: string; logger: Logger }) {
    super();
    this.address = address;
    this.logger = logger;
  }

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
    config,
    logger = new Logger(`${this.name}`),
    verifyCallback,
  }: {
    host: string;
    port: number;
    config?: Partial<WebSocketConfig>;
    logger?: Logger;
    verifyCallback?: VerifyCallback;
  }): Promise<WebSocketClient> {
    logger.info(`Create ${this.name} to ${host}:${port}`);
    const wsConfig = {
      ...clientDefault,
      ...config,
    };

    let host_: Host;
    if (Validator.isValidIPv4String(host)[0]) {
      host_ = host as Host;
    } else if (Validator.isValidIPv6String(host)[0]) {
      host_ = `[${host}]` as Host;
    } else {
      throw new errors.ErrorWebSocketClientInvalidHost();
    }
    let port_: Port;
    if (port >= 0 && port <= 65535) {
      port_ = port as Port;
    } else {
      throw new errors.ErrorWebSocketClientInvalidHost();
    }

    const address = `wss://${host_}:${port_}`;

    const client = new this({
      address,
      logger,
    });

    const webSocket = new WebSocket(address, {
      rejectUnauthorized: verifyCallback == null,
    });

    const connectionId = client.connectionMap.allocateId();
    const connection = new WebSocketConnection({
      type: 'client',
      connectionId,
      remoteInfo: {
        host: host_,
        port: port_,
      },
      config: wsConfig,
      socket: webSocket,
      verifyCallback,
      client: client,
      logger: logger.getChild(
        `${WebSocketConnection.name} ${connectionId}`,
      ),
    });
    await connection.start({
      timer: wsConfig.connectTimeoutTime,
    });
    connection.addEventListener(
      events.EventWebSocketConnectionStopped.name,
      async (event: events.EventWebSocketConnectionStopped) => {
        connection.removeEventListener(
          EventAll.name,
          client.handleEventWebSocketConnection,
        );
        await client.handleEventWebSocketConnection(event);
      },
      { once: true },
    );
    connection.addEventListener(
      EventDefault.name,
      client.handleEventWebSocketConnection,
    );
    client._connection = connection;

    logger.info(`Created ${this.name}`);
    return client;
  }

  @createDestroy.ready(new errors.ErrorWebSocketClientDestroyed())
  public get connection() {
    return this._connection;
  }

  public async destroy({
    force = false,
  }: {
    force?: boolean;
  } = {}) {
    this.logger.info(`Destroy ${this.constructor.name} on ${this.address}`);
    for (const connection of this.connectionMap.values()) {
      this._connection.removeEventListener(
        EventAll.name,
        this.handleEventWebSocketConnection,
      );
      await connection.stop({
        errorMessage: 'cleaning up connections',
        force,
      });
    }
    this.logger.info(`Destroyed ${this.constructor.name}`);
  }
}

export default WebSocketClient;
