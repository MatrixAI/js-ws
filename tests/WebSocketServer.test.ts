import { WebSocketServer } from "@";
import fs from 'fs';

describe('test', () => {
  test('test', () => {
    const server = new WebSocketServer({
      config: {
        cert: fs.readFileSync('./cert/cert.pem').toString(),
        key: fs.readFileSync('./cert/key.pem').toString(),
      }
    });
    server.start({
      port: 3000,
    });
  });
});
