import { createServer, type Socket } from "node:net";
import { PassThrough, type Duplex } from "node:stream";
import type Dockerode from "dockerode";

/** A test-only PostgreSQL connection over Docker exec. The database container
 * stays on an internal network, with no published ports, host credentials or
 * Docker socket. Only the test process can open the loopback proxy. */
export async function isolatedPostgresProxy(docker: Dockerode, container: Dockerode.Container) {
  const sockets = new Set<Socket>();
  const streams = new Set<Duplex>();
  let closing = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    void (async () => {
      const exec = await container.exec({
        Cmd: ["nc", "127.0.0.1", "5432"],
        AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false,
      });
      const stream = await exec.start({ hijack: true, stdin: true }) as Duplex;
      if (closing || socket.destroyed) { stream.destroy(); return; }
      streams.add(stream);
      stream.once("close", () => { streams.delete(stream); socket.destroy(); });
      stream.on("error", () => socket.destroy());
      stream.once("end", () => socket.end());
      socket.once("close", () => stream.destroy());
      const stderr = new PassThrough();
      stderr.on("data", () => socket.destroy(new Error("Isolated PostgreSQL relay failed")));
      docker.modem.demuxStream(stream, socket, stderr);
      socket.pipe(stream);
    })().catch(() => socket.destroy(new Error("Cannot open isolated PostgreSQL relay")));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing isolated PostgreSQL proxy address");
  return {
    port: address.port,
    async close() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      for (const stream of streams) stream.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
