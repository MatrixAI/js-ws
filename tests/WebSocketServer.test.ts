import WebSocketServer from "@/WebSocketServer";
import * as testsUtils from './utils';

describe('test', () => {
  test('test', async () => {
    const tlsConfigServer = await testsUtils.generateConfig('RSA');
    const server = new WebSocketServer({
      config: {
        ...tlsConfigServer
      }
    });
    server.start({
      port: 3000,
    });
  });
});
