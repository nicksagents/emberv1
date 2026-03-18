import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { FastifyRequest } from "fastify";

import { authorizeApiRequest, resolveApiAuthConfig } from "./security.js";

type ApiRoute = {
  method: string;
  path: string;
};

function collectApiRoutesFromIndexSource(): ApiRoute[] {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const indexPath = path.join(thisDir, "index.ts");
  const source = readFileSync(indexPath, "utf8");
  const routes = new Map<string, ApiRoute>();
  const routePattern = /app\.(get|post|put|patch|delete)\(\s*["'](\/api\/[^"']+)["']/g;
  for (const match of source.matchAll(routePattern)) {
    const method = (match[1] ?? "").toUpperCase();
    const routePath = match[2] ?? "";
    if (!method || !routePath) {
      continue;
    }
    routes.set(`${method}:${routePath}`, {
      method,
      path: routePath,
    });
  }
  return [...routes.values()];
}

function mockApiRequest(route: ApiRoute, headers: Record<string, string> = {}): FastifyRequest {
  return {
    method: route.method,
    url: route.path,
    headers,
  } as unknown as FastifyRequest;
}

function isPublicRoute(route: ApiRoute): boolean {
  return route.path === "/api/health";
}

test("all API routes require bearer auth when auth is enabled", () => {
  const routes = collectApiRoutesFromIndexSource();
  assert.ok(routes.length > 0, "expected to discover API routes in index.ts");

  const config = resolveApiAuthConfig({
    NODE_ENV: "production",
    EMBER_API_TOKEN: "test-shared-token",
  } as NodeJS.ProcessEnv);
  assert.equal(config.enabled, true);

  for (const route of routes) {
    const result = authorizeApiRequest(mockApiRequest(route), config);
    if (isPublicRoute(route)) {
      assert.deepEqual(result, { ok: true }, `${route.method} ${route.path} should stay public`);
      continue;
    }
    assert.deepEqual(
      result,
      {
        ok: false,
        statusCode: 401,
        message: "Missing Bearer token.",
      },
      `${route.method} ${route.path} should reject missing bearer auth`,
    );
  }
});

test("all API routes accept bearer auth when auth is enabled", () => {
  const routes = collectApiRoutesFromIndexSource();
  assert.ok(routes.length > 0, "expected to discover API routes in index.ts");

  const config = resolveApiAuthConfig({
    NODE_ENV: "production",
    EMBER_API_TOKEN: "test-shared-token",
  } as NodeJS.ProcessEnv);
  assert.equal(config.enabled, true);

  for (const route of routes) {
    const result = authorizeApiRequest(mockApiRequest(route, {
      authorization: "Bearer test-shared-token",
    }), config);
    assert.deepEqual(
      result,
      { ok: true },
      `${route.method} ${route.path} should accept valid bearer auth`,
    );
  }
});
