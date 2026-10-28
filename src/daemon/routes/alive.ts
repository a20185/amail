import type { Route } from "../router.js";
import { sendJson } from "../router.js";
import { AliveInfoSchema } from "../../contract/api.js";
import { DAEMON_VERSION, userAddress } from "../server.js";
/** LAN 面：GET /alive —— 配对前公开可读的存活信息 */
const route: Route = {
  method: "GET",
  path: "/alive",
  lan: true,
  handler({ res, db, dirs, identity }) {
    const row = db.prepare("SELECT COUNT(*) AS c FROM peers WHERE revoked_at IS NULL").get() as {
      c: number;
    };
    sendJson(
      res,
      200,
      AliveInfoSchema.parse({
        user: userAddress(dirs, identity),
        deviceName: identity.deviceName,
        fingerprint: identity.deviceId,
        version: DAEMON_VERSION,
        pairedCount: row.c,
      }),
    );
  },
};

export default [route];
