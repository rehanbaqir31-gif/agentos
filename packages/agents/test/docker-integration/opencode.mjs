import { Buffer } from "node:buffer";
import http from "node:http";
import process from "node:process";

if (process.argv[2] === "--version") {
  process.stdout.write("1.2.0\n");
  process.exit(0);
}

if (process.argv[2] !== "serve") process.exit(2);

const server = http.createServer((request, response) => {
  const expected = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
  if (request.headers.authorization !== expected) {
    response.writeHead(401).end();
    return;
  }
  if (request.url === "/global/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ healthy: true, version: "1.2.0" }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(4096, "0.0.0.0");
