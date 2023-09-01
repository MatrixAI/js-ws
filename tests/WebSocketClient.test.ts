import type { WebSocketConnectionStreamEvent } from '@/events';
import Logger, { formatting, LogLevel, StreamHandler } from '@matrixai/logger';
import { serverDefault } from '@/config';
import WebSocketClient from '@/WebSocketClient';
import WebSocketServer from '@/WebSocketServer';
import * as testsUtils from './utils';

// Process.on('unhandledRejection', (reason) => {
//   console.log(reason); // log the reason including the stack trace
//   throw reason;
// });

describe(WebSocketClient.name, () => {
  const logger = new Logger('websocket test', LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);
  let tlsConfigServer: testsUtils.TLSConfigs;

  beforeAll(async () => {
    tlsConfigServer = await testsUtils.generateConfig('RSA');
  });

  test('test', async () => {
    const server = new WebSocketServer({
      config: tlsConfigServer,
      logger,
    });
    await server.start();

    server.addEventListener(
      'connectionStream',
      async (event: WebSocketConnectionStreamEvent) => {
        // Await event.detail.readable.getReader().read();
      },
    );

    const client = await WebSocketClient.createWebSocketClient({
      host: server.getHost(),
      port: server.getPort(),
      logger,
      verifyCallback: async (cert) => {},
    });

    const stream1 = await client.connection.streamNew('bidi');
    await stream1.writable
      .getWriter()
      .write(new Uint8Array(serverDefault.streamBufferSize));
    await stream1.destroy();
  });
});
