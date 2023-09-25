import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import * as events from '@/events';
import WebSocketClient from '@/WebSocketClient';
import WebSocketServer from '@/WebSocketServer';
import * as utils from '@/utils';
import * as testsUtils from './utils';
import WebSocketConnection from '@/WebSocketConnection';

// Process.on('unhandledRejection', (reason) => {
//   console.log(reason); // log the reason including the stack trace
//   throw reason;
// });

describe(WebSocketConnection.name, () => {
  const logger = new Logger('websocket test', LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  let tlsConfigServer: testsUtils.TLSConfigs;

  beforeAll(async () => {
    tlsConfigServer = await testsUtils.generateConfig('RSA');
  });

  test('handles a connection and closes before message', async () => {
    const server = new WebSocketServer({
      config: tlsConfigServer,
      logger,
    });
    await server.start({ host: '::1' });

    const client = await WebSocketClient.createWebSocketClient({
      host: server.host,
      port: server.port,
      logger,
      config: {
        verifyPeer: false,
      },
    });

    const stream = await client.connection.newStream();

    const reader = stream.readable.getReader();

    await server.stop({ force: true });

    await expect(reader.read()).toReject();
  });
  test('connection dispatches correct close event', async () => {
    const connectionProm = utils.promise();

    const server = new WebSocketServer({
      config: tlsConfigServer,
      logger,
    });
    await server.start({ host: '::1' });

    server.addEventListener(events.EventWebSocketServerConnection.name, () => {
      connectionProm.resolveP();
    });

    const client = await WebSocketClient.createWebSocketClient({
      host: server.host,
      port: server.port,
      logger,
      config: {
        verifyPeer: false,
      },
    });

    const closeProm = utils.promise<events.EventWebSocketConnectionClose>();

    client.connection.addEventListener(
      events.EventWebSocketConnectionClose.name,
      closeProm.resolveP as any,
    );

    await client.destroy();

    const closeDetail = (await closeProm.p).detail;

    expect(closeDetail.data.errorCode).toBe(utils.ConnectionErrorCode.Normal);

    await server.stop();
  });
});
