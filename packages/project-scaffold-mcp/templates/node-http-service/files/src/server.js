import { createServer } from "node:http";

const port = Number(process.env.PORT || {{port}});

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "{{package_name}}" }));
    return;
  }

  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("{{app_title}} is ready for real routes.");
});

server.listen(port, () => {
  console.log(`Listening on http://127.0.0.1:${port}`);
});
