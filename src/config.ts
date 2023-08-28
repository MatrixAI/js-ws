import type { WebSocketConfig } from './types';

const serverDefault: WebSocketConfig = {
  connectTimeoutTime: 120,
  keepAliveIntervalTime: 1_000,
  keepAliveTimeoutTime: 10_000,
  streamBufferSize: 1024 * 1024 // 1MB
};

const clientDefault: WebSocketConfig = {
  connectTimeoutTime: Infinity,
  keepAliveIntervalTime: 1_000,
  keepAliveTimeoutTime: 10_000,
  streamBufferSize: 1024 * 1024 // 1MB
}

export { serverDefault, clientDefault };
