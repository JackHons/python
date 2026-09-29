import net from "node:net";
import { execFileSync } from "node:child_process";

const distro = process.env.WSL_DISTRO_NAME ?? "Ubuntu-StrongRuntime";
const listenHost = "127.0.0.1";
const listenPort = Number(process.env.FORWARD_LISTEN_PORT ?? 3000);
const targetPort = Number(process.env.FORWARD_TARGET_PORT ?? 3000);
const fixedTargetHost = process.env.FORWARD_TARGET_HOST;

function resolveWslAddress() {
  if (fixedTargetHost) return fixedTargetHost;
  const output = execFileSync("wsl.exe", ["-d", distro, "--", "hostname", "-I"], { encoding: "utf8" });
  const address = output.trim().split(/\s+/).find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value));
  if (!address) throw new Error(`Unable to resolve an IPv4 address for ${distro}`);
  return address;
}

const server = net.createServer((client) => {
  let upstream;
  try {
    upstream = net.createConnection({ host: resolveWslAddress(), port: targetPort });
  } catch (error) {
    client.destroy(error);
    return;
  }
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
});

server.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

server.listen(listenPort, listenHost);
