// Serves the built app and sends visitors of the other domains to tabbycats.party.
const CANONICAL = 'tabbycats.party';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== CANONICAL && url.hostname.endsWith('.party')) {
      url.hostname = CANONICAL;
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
