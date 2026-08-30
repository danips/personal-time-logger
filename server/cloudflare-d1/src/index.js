import { authenticate } from "./auth.js";
import { corsHeaders, handlePreflight, validateOrigin } from "./cors.js";
import { ApiError, ERROR, errorResponse } from "./errors.js";
import { jsonBody, jsonResponse } from "./http.js";
import * as repository from "./repository.js";

const ROUTES = new Map([
  ["/v1/health", "GET"], ["/v1/change-token", "GET"], ["/v1/snapshot", "GET"],
  ["/v1/entries/append", "POST"], ["/v1/entries/update", "POST"],
  ["/v1/entries/delete", "POST"], ["/v1/config/update", "POST"]
]);

function routeNotFound() {
  return new ApiError(404, ERROR.ROUTE_NOT_FOUND, "The requested API route does not exist.");
}

export default {
  async fetch(request, env) {
    let origin = null;
    try {
      const url = new globalThis.URL(request.url);
      origin = validateOrigin(request);
      if (request.method === "OPTIONS") return handlePreflight(request, origin);
      if (url.pathname.startsWith("/v1/")) await authenticate(request, env);
      const expectedMethod = ROUTES.get(url.pathname);
      if (!expectedMethod) throw routeNotFound();
      if (request.method !== expectedMethod) throw new ApiError(405, ERROR.METHOD_NOT_ALLOWED, "The requested method is not allowed.");
      let result;
      if (url.pathname === "/v1/health") result = await repository.health(env.DB);
      else if (url.pathname === "/v1/change-token") result = { changeToken: await repository.changeToken(env.DB) };
      else if (url.pathname === "/v1/snapshot") result = await repository.snapshot(env.DB);
      else {
        const body = await jsonBody(request);
        if (url.pathname === "/v1/entries/append") result = await repository.append(env.DB, body);
        else if (url.pathname === "/v1/entries/update") result = await repository.update(env.DB, body);
        else if (url.pathname === "/v1/entries/delete") result = await repository.remove(env.DB, body);
        else result = await repository.updateConfig(env.DB, body);
      }
      return jsonResponse(result, 200, corsHeaders(origin));
    } catch (error) {
      return errorResponse(error, corsHeaders(origin));
    }
  }
};

export { ROUTES };
