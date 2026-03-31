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

// ─── Tool 1: Search Spotify — returns top 5 matches for user to confirm ──────

worker.tool("searchSpotifyTrack", {
  title: "Search Spotify for Track",
  description:
    "Searches Spotify for a track by song title and artist name. Returns a numbered list of up to 5 matches including track name, artist, album, release year, and Spotify URL so the user can confirm the correct track.",

  schema: j.object({
    song: j.string().describe("The title of the song to search for."),
    artist: j.string().describe("The name of the artist or performer."),
  }),

  outputSchema: j.object({
    found: j.boolean().describe("Whether any matches were found."),
    matches: j.array(
      j.object({
        index: j.number().describe("Match number (1-5)."),
        track_name: j.string().describe("Track name."),
        artist: j.string().describe("Artist name(s)."),
        album: j.string().describe("Album or EP title."),
        release_year: j.string().describe("Release year."),
        track_id: j.string().describe("Spotify track ID — needed for fetchSpotifyMetadata."),
        spotify_url: j.string().nullable().describe("Direct Spotify link."),
      })
    ),
    message: j.string().describe("Summary message for the agent."),
  }),

  execute: async ({ song, artist }) => {
    let accessToken: string;
    try {
      accessToken = await getSpotifyToken();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { found: false, matches: [], message: `Authentication failed: ${message}` };
    }

    const query = encodeURIComponent(`track:${song} artist:${artist}`);
    const searchResponse = await fetch(
      `https://api.spotify.com/v1/search?q=${query}&type=track&limit=5`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!searchResponse.ok) {
      return { found: false, matches: [], message: `Spotify search failed: ${searchResponse.statusText}` };
    }

    const searchData = (await searchResponse.json()) as {
      tracks?: { items: Array<{ id: string; name: string; artists: Array<{ name: string }>; album: { name: string; release_date: string }; external_urls?: { spotify?: string } }> };
    };

    const tracks = searchData.tracks?.items;
    if (!tracks || tracks.length === 0) {
      return {
        found: false,
        matches: [],
        message: `No results found for "${song}" by "${artist}". Check spelling or try a Spotify/Apple Music link.`,
      };
    }

    const matches = tracks.map((t, i) => ({
      index: i + 1,
      track_name: t.name,
      artist: t.artists.map((a) => a.name).join(", "),
      album: t.album.name,
      release_year: t.album.release_date.substring(0, 4),
      track_id: t.id,
      spotify_url: t.external_urls?.spotify ?? null,
    }));

    return {
      found: true,
      matches,
      message: `Found ${matches.length} match(es). Present the list to the user and ask them to confirm the correct track by number.`,
    };
  },
});

// ─── Tool 2: Fetch full metadata for a confirmed track ID ─────────────────────

worker.tool("fetchSpotifyMetadata", {
  title: "Fetch Full Spotify Metadata",
  description:
    "Fetches full metadata for a confirmed Spotify track ID. Returns ISRC, UPC, BPM, Loudness, Duration, Release Date, Artwork URL, Spotify URL, and Record Label as structured fields ready to write to the tracker.",

  schema: j.object({
    track_id: j.string().describe("The Spotify track ID from the confirmed match."),
  }),

  outputSchema: j.object({
    track_name: j.string().describe("Track name."),
    artist: j.string().describe("Artist name(s)."),
    album: j.string().describe("Album or EP title."),
    release_date: j.string().describe("Full release date (YYYY-MM-DD)."),
    duration: j.string().describe("Duration formatted as m:ss — write to Length field."),
    isrc: j.string().describe("ISRC code — write to ISRC field."),
    upc: j.string().describe("UPC barcode — write to UPC field."),
    bpm: j.string().describe("Tempo in BPM — write to BPM field."),
    loudness: j.string().describe("Loudness in dB — write to Loudness (LUFS) field."),
    label: j.string().describe("Record label — write to Record Label field."),
    artwork_url: j.string().nullable().describe("Artwork image URL — write to Artwork Link field."),
    spotify_url: j.string().nullable().describe("Spotify track URL — write to Streaming Link field."),
  }),

  execute: async ({ track_id }) => {
    let accessToken: string;
    try {
      accessToken = await getSpotifyToken();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Authentication failed: ${message}`);
    }

    // Fetch track
    const trackResponse = await fetch(
      `https://api.spotify.com/v1/tracks/${track_id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const t = (await trackResponse.json()) as {
      name: string;
      artists: Array<{ name: string }>;
      album: { id: string; name: string; release_date: string; images: Array<{ url: string }> };
      duration_ms: number;
      external_ids?: { isrc?: string };
      external_urls?: { spotify?: string };
    };

    // Fetch album (UPC + label)
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
      `https://api.spotify.com/v1/audio-features/${track_id}`,
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
      bpm: audio.tempo ? Math.round(audio.tempo).toString() : "Not found",
      loudness: audio.loudness ? `${audio.loudness.toFixed(1)} dB` : "Not found",
      label: album.label ?? "Not found",
      artwork_url: t.album.images[0]?.url ?? null,
      spotify_url: t.external_urls?.spotify ?? null,
    };
  },
});
