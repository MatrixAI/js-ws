import { WebSocketConfig } from "./types";

const serverDefault: WebSocketConfig = {
  connectTimeoutTime: 120,
  keepAliveIntervalTime: 1_000,
  keepAliveTimeoutTime: 10_000,
}

export {
  serverDefault,
}
