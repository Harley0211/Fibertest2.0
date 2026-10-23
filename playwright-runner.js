const http = require("http");
const { spawn } = require("child_process");

const PORT = 3030;
const HOST = "127.0.0.1";

// Replace this with your own long, random secret.
// Use the same value in the n8n HTTP Request node later.
const TOKEN = "this-is-a-long-random-secret-token-1234567890";

const TESTS = {
  autopay: "tests/buyflow-autopay.spec.js",
  nonautopay: "tests/buyflow-nonautopay.spec.js",
};

let isRunning = false;

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    return res.end(
      JSON.stringify({
        ok: true,
        message: "Playwright runner is online",
      }),
    );
  }

  if (req.method !== "POST" || req.url !== "/run") {
    res.writeHead(404);
    return res.end(JSON.stringify({ error: "Not found" }));
  }

  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  let body = "";

  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 10000) req.destroy();
  });

  req.on("end", () => {
    let data;

    try {
      data = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Invalid JSON" }));
    }

    const testFile = TESTS[data.scenario];

    if (!testFile) {
      res.writeHead(400);
      return res.end(
        JSON.stringify({
          error: "Use scenario autopay or nonautopay",
        }),
      );
    }

    if (isRunning) {
      res.writeHead(409);
      return res.end(
        JSON.stringify({
          error: "A Playwright test is already running",
        }),
      );
    }

    isRunning = true;
    let output = "";

    console.log(`Starting ${data.scenario}: ${testFile}`);

    const child = spawn(
      "npx.cmd",
      ["playwright", "test", testFile, "--reporter=list"],
      {
        cwd: __dirname,
        shell: true,
        windowsHide: true,
      },
    );

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", (error) => {
      isRunning = false;

      if (!res.headersSent) {
        res.writeHead(500);
        res.end(
          JSON.stringify({
            ok: false,
            scenario: data.scenario,
            error: error.message,
          }),
        );
      }
    });

    child.on("close", (code) => {
      isRunning = false;

      if (res.destroyed) return;

      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: code === 0,
          scenario: data.scenario,
          exitCode: code,
          output: output.slice(-15000),
        }),
      );

      console.log(`Finished ${data.scenario}: exit code ${code}`);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Playwright runner listening on http://${HOST}:${PORT}`);
  console.log("Available scenarios: autopay, nonautopay");
});
