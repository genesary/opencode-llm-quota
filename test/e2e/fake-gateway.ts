// Stand-in for agentgateway: `/v1/quota` answers from fixtures set over
// `PUT /__quota/<model>`, `/v1/chat/completions` streams a short reply, and every
// request is recorded for `GET /__calls`. A prompt containing "use the quota tool"
// gets a tool call to `quota` first, so the tool output comes back in the next request.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Call {
  at: number;
  method: string | undefined;
  path: string;
  model: string | null;
  authorization: string | null;
  body: string;
}

export interface Gateway {
  url: string;
  calls: () => Call[];
  setQuota: (model: string, fixture: unknown) => void;
  close: () => Promise<void>;
}

type Reply =
  { text: string; tool?: undefined } | { tool: { name: string; arguments: string }; text?: undefined };

export function startGateway({
  token,
  quota = {},
  port = 0,
}: {
  token: string;
  quota?: Record<string, unknown>;
  port?: number;
}): Promise<Gateway> {
  const calls: Call[] = [];
  const fixtures = new Map(Object.entries(quota));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    const body = await readBody(req);
    const authorization = req.headers["authorization"] ?? null;
    if (!url.pathname.startsWith("/__")) {
      calls.push({
        at: Date.now(),
        method: req.method,
        path: url.pathname,
        model: url.searchParams.get("model"),
        authorization,
        body,
      });
    }

    if (url.pathname === "/__calls") return json(res, 200, calls);
    if (url.pathname.startsWith("/__quota/") && req.method === "PUT") {
      fixtures.set(decodeURIComponent(url.pathname.slice("/__quota/".length)), JSON.parse(body));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/v1/quota") {
      if (authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "text/plain" }).end("authentication failure: jwt");
        return;
      }
      const fixture = fixtures.get(url.searchParams.get("model") ?? "");
      return fixture ? json(res, 200, fixture) : json(res, 404, { error: "unknown model" });
    }

    if (url.pathname === "/v1/models") {
      return json(res, 200, {
        object: "list",
        data: [...fixtures.keys()].map((id) => ({ id, object: "model" })),
      });
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const request = JSON.parse(body || "{}") as {
        model?: string;
        messages?: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const messages = request.messages ?? [];
      const last = messages.at(-1);
      const wantsTool =
        last?.role === "user" && JSON.stringify(last.content).includes("use the quota tool") && request.tools;
      if (!wantsTool) return stream(res, request.model, { text: "Done." });
      // OpenCode 2.3 exposes plugin tools through Code Mode (`execute`) only.
      const names = (request.tools ?? []).map((t) => t.function?.name);
      const call = names.includes("quota")
        ? { name: "quota", arguments: "{}" }
        : { name: "execute", arguments: JSON.stringify({ code: "return await tools.quota()" }) };
      return stream(res, request.model, { tool: call });
    }

    json(res, 404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        calls: () => calls,
        setQuota: (model, fixture) => fixtures.set(model, fixture),
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

function stream(res: ServerResponse, model: string | undefined, reply: Reply): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const id = `chatcmpl-${Date.now()}`;
  const chunk = (delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  if (reply.tool) {
    chunk({
      role: "assistant",
      tool_calls: [{ index: 0, id: "call_quota", type: "function", function: reply.tool }],
    });
    chunk({}, "tool_calls");
  } else {
    chunk({ role: "assistant", content: reply.text });
    chunk({}, "stop");
  }
  res.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}
