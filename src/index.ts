import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

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
    "Searches Spotify for a track by song title and artist name. Returns metadata including ISRC, UPC, duration, BPM, loudness, streaming link, release date, album, and artwork URL. Returns the top 5 matches so the user can confirm the correct track before any data is written.",

  schema: j.object({
    song: j
      .string()
      .describe("The title of the song to search for on Spotify."),
    artist: j
      .string()
      .describe("The name of the artist or primary performer of the song."),
  }),

  outputSchema: j.object({
    track_name: j.string().describe("The name of the track on Spotify."),
    artist: j.string().describe("The artist(s) name(s)."),
    album: j.string().describe("The album or EP title."),
    release_date: j.string().describe("The release date of the track."),
    duration: j.string().describe("Track duration formatted as mm:ss."),
    isrc: j.string().describe("The ISRC code for this recording."),
    upc: j.string().describe("The UPC barcode for the album."),
    bpm: j.string().describe("Tempo in beats per minute, rounded to nearest whole number."),
    loudness: j.string().describe("Integrated loudness in dB as returned by Spotify."),
    label: j.string().describe("The record label from the album."),
    artwork_url: j.string().nullable().describe("URL to the album artwork image."),
    spotify_url: j.string().nullable().describe("Direct Spotify link to the track."),
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

    // STEP 3 — Fetch full track + album + audio features for each result
    const results = await Promise.all(
      tracks.map(async (track) => {
        // Fetch track (ISRC + core metadata)
        const trackResponse = await fetch(
          `https://api.spotify.com/v1/tracks/${track.id}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const t = (await trackResponse.json()) as {
          name: string;
          artists: Array<{ name: string }>;
          album: {
            id: string;
            name: string;
            release_date: string;
            images: Array<{ url: string }>;
          };
          duration_ms: number;
          external_ids?: { isrc?: string };
          external_urls?: { spotify?: string };
        };

        // Fetch album (UPC)
        const albumResponse = await fetch(
          `https://api.spotify.com/v1/albums/${t.album.id}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const album = (await albumResponse.json()) as {
          external_ids?: { upc?: string };
          label?: string;
        };

        // Fetch audio features (BPM + Loudness)
        const audioResponse = await fetch(
          `https://api.spotify.com/v1/audio-features/${track.id}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const audio = (await audioResponse.json()) as {
          tempo?: number;
          loudness?: number;
        };

        return {
          track_name: t.name,
          artist: t.artists.map((a) => a.name).join(", "),
          album: t.album.name,
          release_date: t.album.release_date,
          duration: formatDuration(t.duration_ms),
          isrc: t.external_ids?.isrc ?? "Not found",
          upc: album.external_ids?.upc ?? "Not found",
          label: album.label ?? "Not found",
          bpm: audio.tempo ? Math.round(audio.tempo).toString() : "Not found",
          loudness: audio.loudness ? `${audio.loudness.toFixed(1)} dB` : "Not found",
          artwork_url: t.album.images[0]?.url ?? null,
          spotify_url: t.external_urls?.spotify ?? null,
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
          `• UPC: ${r.upc}`,
          `• BPM: ${r.bpm}`,
          `• Loudness: ${r.loudness}`,
          `• Record Label: ${r.label}`,
          `• Artwork: ${r.artwork_url ?? "Not available"}`,
          `• Spotify URL: ${r.spotify_url ?? "Not available"}`,
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
