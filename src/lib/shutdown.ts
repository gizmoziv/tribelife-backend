import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { Pool } from 'pg';
import type { ScheduledTask } from 'node-cron';
import logger from './logger';

const log = logger.child({ module: 'shutdown' });

export interface ShutdownOptions {
  httpServer: HttpServer;
  io: SocketServer;
  pool: Pool;
  cronTasks: ScheduledTask[];
}

/**
 * Registers SIGTERM/SIGINT handlers that run a bounded graceful shutdown
 * sequence (HARDEN-02).
 *
 * Operation order (D-09):
 *   1. Set shuttingDown guard (D-13).
 *   2. Start 10s watchdog (D-12) — unref()'d so a fast clean shutdown
 *      does not block on it.
 *   3. httpServer.close()           — stop accepting new requests.
 *   4. httpServer.closeIdleConnections() — Node 18.2+, drop idle keep-alive.
 *   5. task.stop() per cron         — stop future triggers; let in-flight finish.
 *   6. io.emit('server:shutdown', { reason: 'rolling_deploy' }) + wait 5s (D-15).
 *   7. httpServer.closeAllConnections() — force-close lingering HTTP.
 *   8. io.close()                   — close remaining sockets.
 *   9. pool.end()                   — drain in-flight Postgres queries.
 *  10. process.exit(0).
 *
 * Idempotency (D-13): second signal while shuttingDown=true logs warn and no-ops.
 * Both SIGTERM and SIGINT use the same handler (D-08) so Ctrl+C in dev
 * exercises the production path.
 */
export function registerShutdownSignals(opts: ShutdownOptions): void {
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      log.warn(
        { event: 'shutdown_already_in_progress', signal },
        'Shutdown already in progress — ignoring signal',
      );
      return;
    }
    shuttingDown = true;
    const startedAt = Date.now();

    // D-12: watchdog — force exit at T+10s if graceful path stalls.
    // .unref() so this timer does NOT keep the event loop alive during
    // a fast clean shutdown.
    setTimeout(() => {
      log.error(
        { event: 'shutdown_timeout' },
        'Graceful shutdown timed out — forcing exit(1)',
      );
      process.exit(1);
    }, 10_000).unref();

    log.info(
      { event: 'shutdown_starting', signal },
      'Graceful shutdown starting',
    );

    // Step 3: stop accepting new HTTP requests.
    opts.httpServer.close();
    // Step 4: drop idle keep-alive sockets immediately (Node 18.2+).
    opts.httpServer.closeIdleConnections();

    // Step 5: stop cron scheduling. Does NOT abort in-flight runs — we let
    // them finish; pool.end() below waits for their queries.
    for (const task of opts.cronTasks) {
      task.stop();
    }
    log.info(
      { event: 'shutdown_step_cron_stopped', count: opts.cronTasks.length },
      'Cron tasks stopped',
    );

    // Step 6: notify connected clients + wait up to 5s for them to
    // reconnect to another pod (D-15).
    opts.io.emit('server:shutdown', { reason: 'rolling_deploy' });
    log.info({ event: 'shutdown_step_notified_clients' }, 'Clients notified');
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));

    // Step 7: force-close lingering HTTP (Node 18.2+).
    opts.httpServer.closeAllConnections();
    log.info({ event: 'shutdown_step_http_closed' }, 'HTTP connections closed');

    // Step 8: close Socket.IO. io.close() is callback-style — wrap in Promise.
    await new Promise<void>((resolve) => opts.io.close(() => resolve()));
    log.info({ event: 'shutdown_step_io_closed' }, 'Socket.IO closed');

    // Step 9: drain Postgres pool (awaits in-flight queries including any
    // cron jobs still finishing).
    await opts.pool.end();
    log.info({ event: 'shutdown_step_pool_closed' }, 'Postgres pool closed');

    const durationMs = Date.now() - startedAt;
    log.info(
      { event: 'shutdown_complete', durationMs },
      'Graceful shutdown complete',
    );
    process.exit(0);
  }

  // D-08: same handler for SIGTERM (DO rolling deploy) and SIGINT (dev Ctrl+C).
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}
