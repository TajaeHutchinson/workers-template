import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SpotifyTrackResult {
  track_name: string;
  artist: string;
  album: string;
  release_date: string;
  duration: string;
  isrc: string;
  artwork_url: string | null;
  spotify_url: string | null;
  popularity: number;
}

// ─── Helper: Get Spotify Access Token ────────────────────────────────────────

async function getSpotifyToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET environment variables."
    );
  }

  const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
    },
    body: "grant_type=client_credentials",
  });

  if (!tokenResponse.ok) {
    throw new Error(
      `Spotify authentication failed: ${tokenResponse.statusText}`
    );
  }

  const tokenData = (await tokenResponse.json()) as { access_token: string };
  return tokenData.access_token;
}

// ─── Helper: Convert ms to mm:ss ─────────────────────────────────────────────

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

// ─── Tool: Search Spotify for Track Metadata ─────────────────────────────────

worker.tool("searchSpotifyMetadata", {
  title: "Search Spotify for Track Metadata",
  description:
    "Searches Spotify for a track by song title and artist name. Returns metadata including ISRC, duration, release date, album, artwork URL, and Spotify link. Returns the top 5 matches so the user can confirm the correct track before any data is written.",

  schema: j.object({
    song: j
      .string()
      .describe("The title of the song to search for on Spotify."),
    artist: j
      .string()
      .describe(
        "The name of the artist or primary performer of the song."
      ),
  }),

  execute: async ({ song, artist }): Promise<string> => {
    // STEP 1 — Authenticate with Spotify
    let accessToken: string;
    try {
      accessToken = await getSpotifyToken();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `❌ Spotify authentication failed: ${message}`;
    }

    // STEP 2 — Search for the track
    const query = encodeURIComponent(`track:${song} artist:${artist}`);
    const searchResponse = await fetch(
      `https://api.spotify.com/v1/search?q=${query}&type=track&limit=5`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!searchResponse.ok) {
      return `❌ Spotify search failed: ${searchResponse.statusText}`;
    }

    const searchData = (await searchResponse.json()) as {
      tracks?: { items: Array<{ id: string }> };
    };
    const tracks = searchData.tracks?.items;

    if (!tracks || tracks.length === 0) {
      return (
        `No results found for "${song}" by "${artist}". ` +
        `Please check the spelling or try an alternate version of the title.`
      );
    }

    // STEP 3 — Fetch full details + ISRC for each result
    const results: SpotifyTrackResult[] = await Promise.all(
      tracks.map(async (track) => {
        const trackResponse = await fetch(
          `https://api.spotify.com/v1/tracks/${track.id}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const t = (await trackResponse.json()) as {
          name: string;
          artists: Array<{ name: string }>;
          album: {
            name: string;
            release_date: string;
            images: Array<{ url: string }>;
          };
          duration_ms: number;
          external_ids?: { isrc?: string };
          external_urls?: { spotify?: string };
          popularity: number;
        };

        return {
          track_name: t.name,
          artist: t.artists.map((a) => a.name).join(", "),
          album: t.album.name,
          release_date: t.album.release_date,
          duration: formatDuration(t.duration_ms),
          isrc: t.external_ids?.isrc ?? "Not found",
          artwork_url: t.album.images[0]?.url ?? null,
          spotify_url: t.external_urls?.spotify ?? null,
          popularity: t.popularity,
        };
      })
    );

    // STEP 4 — Format results for the agent to present to the user
    const formatted = results
      .map((r, i) => {
        return [
          `**Match ${i + 1}:**`,
          `• Track: ${r.track_name}`,
          `• Artist: ${r.artist}`,
          `• Album: ${r.album}`,
          `• Release Date: ${r.release_date}`,
          `• Duration: ${r.duration}`,
          `• ISRC: ${r.isrc}`,
          `• Artwork: ${r.artwork_url ?? "Not available"}`,
          `• Spotify URL: ${r.spotify_url ?? "Not available"}`,
          `• Popularity Score: ${r.popularity}/100`,
        ].join("\n");
      })
      .join("\n\n");

    return (
      `Found ${results.length} match(es) for "${song}" by "${artist}":\n\n` +
      formatted +
      `\n\n⚠️ Please confirm with the user which match is correct before updating the tracker.`
    );
  },
});
