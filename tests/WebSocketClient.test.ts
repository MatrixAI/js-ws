import WebSocketClient from "@/WebSocketClient";
import WebSocketServer from "@/WebSocketServer";
import Logger, { formatting, LogLevel, StreamHandler } from "@matrixai/logger";
import * as testsUtils from "./utils";

describe(WebSocketClient.name, () => {
  let tlsConfigServer: testsUtils.TLSConfigs;

  beforeAll(async () => {
    tlsConfigServer = await testsUtils.generateConfig("RSA");
  });

  const logger = new Logger('websocket test', LogLevel.WARN, [
    new StreamHandler(
      formatting.format`${formatting.level}:${formatting.keys}:${formatting.msg}`,
    ),
  ]);

  test('test', async () => {
    const server = new WebSocketServer({
      config: tlsConfigServer,
      logger
    });
    await server.start();

    const client = await WebSocketClient.createWebSocketClient({
      host: server.getHost(),
      port: server.getPort(),
      logger,
      verifyCallback: async (cert) => {},
    });

    const stream1 = await client.connection.streamNew('bidi');
    stream1.writable.getWriter().write(new Uint8Array([1, 2, 3]));

  });
});
