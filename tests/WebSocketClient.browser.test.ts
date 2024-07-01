import type { KeyTypes } from './utils.js';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import * as ws from 'ws';
import * as testsUtils from './utils.js';
import { promise } from '#utils.js';
import * as events from '#events.js';
import * as errors from '#errors.js';
import WebSocketClient from '#WebSocketClient.js';
import WebSocketServer from '#WebSocketServer.js';

describe(`${WebSocketClient.name} browser`, () => {
  const logger = new Logger(`${WebSocketClient.name} Test`, LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  const localhost = '127.0.0.1';
  const types: Array<KeyTypes> = ['RSA', 'ECDSA', 'ED25519'];
  // Const types: Array<KeyTypes> = ['RSA'];
  const defaultType = types[0];

  class BrowserWebSocket extends ws.WebSocket {
    constructor(address: string, protocols: any) {
      super(address, protocols, {
        rejectUnauthorized: false,
      });
    }
  }

  test('to ipv6 server succeeds', async () => {
    const connectionEventProm =
      promise<events.EventWebSocketServerConnection>();
    const tlsConfigServer = await testsUtils.generateConfig(defaultType);
    const server = new WebSocketServer({
      logger: logger.getChild(WebSocketServer.name),
      config: {
        key: tlsConfigServer.key,
        cert: tlsConfigServer.cert,
        verifyPeer: false,
      },
    });
    server.addEventListener(
      events.EventWebSocketServerConnection.name,
      (e: events.EventWebSocketServerConnection) =>
        connectionEventProm.resolveP(e),
    );
    await server.start({
      host: '::1',
      port: 0,
    });
    const client = await WebSocketClient.createWebSocketClient({
      host: '::1',
      port: server.port,
      logger: logger.getChild(WebSocketClient.name),
      config: {
        verifyPeer: false,
      },
      _webSocketClass: BrowserWebSocket as any,
    });
    const conn = (await connectionEventProm.p).detail;
    expect(conn.localHost).toBe('::1');
    expect(conn.localPort).toBe(server.port);
    expect(conn.remoteHost).toBe('::1');
    await client.destroy();
    await server.stop();
  });
  test('to dual stack server succeeds', async () => {
    const connectionEventProm =
      promise<events.EventWebSocketServerConnection>();
    const tlsConfigServer = await testsUtils.generateConfig(defaultType);
    const server = new WebSocketServer({
      logger: logger.getChild(WebSocketServer.name),
      config: {
        key: tlsConfigServer.key,
        cert: tlsConfigServer.cert,
        verifyPeer: false,
      },
    });
    server.addEventListener(
      events.EventWebSocketServerConnection.name,
      (e: events.EventWebSocketServerConnection) =>
        connectionEventProm.resolveP(e),
    );
    await server.start({
      host: '::',
      port: 0,
    });
    const client = await WebSocketClient.createWebSocketClient({
      host: '::', // Will resolve to ::1
      port: server.port,
      logger: logger.getChild(WebSocketClient.name),
      config: {
        verifyPeer: false,
      },
      _webSocketClass: BrowserWebSocket as any,
    });
    const conn = (await connectionEventProm.p).detail;
    expect(conn.localHost).toBe('::1');
    expect(conn.localPort).toBe(server.port);
    expect(conn.remoteHost).toBe('::1');
    await client.destroy();
    await server.stop();
  });
  describe('hard connection failures', () => {
    test('internal error when there is no server', async () => {
      // WebSocketClient repeatedly dials until the connection timeout
      await expect(
        WebSocketClient.createWebSocketClient({
          host: localhost,
          port: 56666,
          logger: logger.getChild(WebSocketClient.name),
          config: {
            keepAliveTimeoutTime: 200,
            verifyPeer: false,
          },
          _webSocketClass: BrowserWebSocket as any,
        }),
      ).rejects.toHaveProperty(
        ['name'],
        errors.ErrorWebSocketConnectionLocal.name,
      );
    });
    test('client times out with ctx timer while starting', async () => {
      const tlsConfigServer = await testsUtils.generateConfig(defaultType);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigServer.key,
          cert: tlsConfigServer.cert,
          verifyPeer: true,
          verifyCallback: async () => {
            await testsUtils.sleep(1000);
          },
        },
      });
      await server.start({
        host: localhost,
        port: 0,
      });
      await expect(
        WebSocketClient.createWebSocketClient(
          {
            host: localhost,
            port: server.port,
            logger: logger.getChild(WebSocketClient.name),
            config: {
              verifyPeer: false,
            },
            _webSocketClass: BrowserWebSocket as any,
          },
          { timer: 100 },
        ),
      ).rejects.toThrow(errors.ErrorWebSocketClientCreateTimeOut);
      await server.stop();
    });
    test('client times out with ctx signal while starting', async () => {
      const abortController = new AbortController();
      const tlsConfigServer = await testsUtils.generateConfig(defaultType);
      const server = new WebSocketServer({
        logger: logger.getChild(WebSocketServer.name),
        config: {
          key: tlsConfigServer.key,
          cert: tlsConfigServer.cert,
          verifyPeer: true,
          verifyCallback: async () => {
            await testsUtils.sleep(1000);
          },
        },
      });
      await server.start({
        host: localhost,
        port: 0,
      });
      const clientProm = WebSocketClient.createWebSocketClient(
        {
          host: localhost,
          port: server.port,
          logger: logger.getChild(WebSocketClient.name),
          config: {
            verifyPeer: false,
          },
          _webSocketClass: BrowserWebSocket as any,
        },
        { signal: abortController.signal },
      );
      await testsUtils.sleep(100);
      abortController.abort(Error('abort error'));
      await expect(clientProm).rejects.toThrow(Error('abort error'));
      await server.stop();
    });
  });
});
