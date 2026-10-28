import type { DatabaseSync } from "node:sqlite";
import type { Route } from "../router.js";
import { sendJson } from "../router.js";
import { DAEMON_VERSION, userAddress } from "../server.js";

interface OutboxCounts {
  queued: number;
  delivered: number;
  expired: number;
}

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

/** 回环面概况：daemon 版本/地址、未读、出箱各状态数、已配对数 */
const statusRoute: Route = {
  method: "GET",
  path: "/v1/status",
  lan: false,
  handler({ res, db, dirs, identity }) {
    const outbox: OutboxCounts = {
      queued: count(db, "SELECT COUNT(*) AS c FROM outbox WHERE state = 'queued'"),
      delivered: count(db, "SELECT COUNT(*) AS c FROM outbox WHERE state = 'delivered'"),
      expired: count(db, "SELECT COUNT(*) AS c FROM outbox WHERE state = 'expired'"),
    };
    sendJson(res, 200, {
      version: DAEMON_VERSION,
      address: userAddress(dirs, identity),
      unread: count(
        db,
        "SELECT COUNT(*) AS c FROM messages WHERE direction = 'in' AND read_at IS NULL AND archived_at IS NULL",
      ),
      outbox,
      peers: count(db, "SELECT COUNT(*) AS c FROM peers WHERE revoked_at IS NULL"),
    });
  },
};

export default [statusRoute];
