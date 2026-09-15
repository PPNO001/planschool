import { onRequest as handleSyncRequest } from "../functions/api/sync.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/sync") {
      return handleSyncRequest({
        request,
        env,
        params: {},
        data: {},
        functionPath: "/api/sync",
        waitUntil: ctx.waitUntil.bind(ctx),
        next: () => env.ASSETS.fetch(request)
      });
    }

    return env.ASSETS.fetch(request);
  }
};
