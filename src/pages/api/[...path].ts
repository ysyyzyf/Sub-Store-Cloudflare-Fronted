import { getSecret } from "astro:env/server";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { getTokenFromCookie } from "../../lib/auth";

const app = new Hono().basePath("/api");

const BACKEND_URL =
	getSecret("BACKEND_URL") || "https://sub-store-cloudflare.yeckwill.workers.dev";

// Service binding to the backend Worker (see wrangler.jsonc).
// Falls back to a public fetch when the binding is absent (local dev).
const backend = (env as unknown as { BACKEND?: { fetch: typeof fetch } }).BACKEND;

app.get("/__debug", async (c) => {
	const out: Record<string, unknown> = { hasBinding: Boolean(backend) };
	if (backend) {
		for (const u of [
			"https://backend/health",
			"https://backend/api/utils/worker-status",
			"https://backend/api/tokens",
		]) {
			try {
				const r = await backend.fetch(u);
				out[u] = {
					status: r.status,
					contentType: r.headers.get("content-type"),
					body: (await r.text()).slice(0, 200),
				};
			} catch (e) {
				out[u] = { error: String(e) };
			}
		}
	}
	return c.json(out);
});

// Proxy all requests to worker-rs backend
app.all("/*", async (c) => {
	const path = c.req.path;
	const method = c.req.method;

	// Get token from cookie or Authorization header
	const cookieHeader = c.req.header("cookie");
	const cookieToken = getTokenFromCookie(cookieHeader);
	const authHeader = c.req.header("authorization");
	const token = cookieToken || authHeader?.replace("Bearer ", "");

	// Build backend URL (the host is ignored when going through a service binding)
	const url = new URL(c.req.url);
	const backendUrl = `${backend ? "https://backend" : BACKEND_URL}${path}${url.search}`;

	// Forward request to backend
	const headers = new Headers();
	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}

	// Copy relevant headers
	const contentType = c.req.header("content-type");
	if (contentType) headers.set("Content-Type", contentType);

	const accept = c.req.header("accept");
	if (accept) headers.set("Accept", accept);

	try {
		const body = method !== "GET" && method !== "HEAD" ? await c.req.raw.clone().text() : undefined;

		const doFetch = backend ? backend.fetch.bind(backend) : fetch;
		const response = await doFetch(backendUrl, {
			method,
			headers,
			body: body || undefined,
		});

		// Forward response
		const responseHeaders = new Headers();
		responseHeaders.set("Content-Type", response.headers.get("Content-Type") || "application/json");

		return new Response(response.body, {
			status: response.status,
			headers: responseHeaders,
		});
	} catch (error) {
		return c.json({ error: "Backend request failed", message: String(error) }, { status: 502 });
	}
});

export const ALL: APIRoute = async (context) => {
	try {
		return await app.fetch(context.request);
	} catch (e) {
		return new Response(String((e as Error)?.stack || e), { status: 500 });
	}
};
