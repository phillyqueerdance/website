// Shared metadata for the approved profiles in Discover.
(() => {
  const origin = "https://queerdancephilly.com";
  const kinds = Object.freeze({ artist: "artists", venue: "venues", party: "parties", collective: "collectives" });
  const homeDescription = "Queer Philadelphia's guide to finding the next move. Discover queer dance parties, LGBTQ+ nightlife, DJs, artists, venues, and more!";
  const directories = Object.freeze({
    parties: Object.freeze({ kind: "party", title: "Queer Dance Philly | Parties",
      description: "Discover queer dance parties in Philadelphia: when they're happening, who's playing them, and where they're going down." }),
    venues: Object.freeze({ kind: "venue", title: "Queer Dance Philly | Venues",
      description: "Discover queer dance venues in Philadelphia: what's coming up, who's playing, and who's played before." }),
    collectives: Object.freeze({ kind: "collective", title: "Queer Dance Philly | Collectives" })
  });
  const validId = id => typeof id === "string" && /^[\w-]{1,80}$/.test(id);
  const url = (kind, id, base = origin) => {
    const result = new URL("/", base);
    result.searchParams.set("archive", kind);
    result.searchParams.set("id", id);
    return result.href;
  };
  const title = profile => `${profile.name} | Queer Dance Philly`;
  const artistImage = profile => {
    if (Object.hasOwn(profile, "imageUrl")) {
      const src = globalThis.QDPEventMetadata.image({ flyerUrl: profile.imageUrl });
      return src ? { src } : null;
    }
    // Keep the preview portrait only until the publisher supplies the new field.
    return profile.id === "CALLAIA-001"
      ? { src: "/artist-images/callaia.jpg", width: 2048, height: 2016 } : null;
  };
  const directoryUrl = (kind, base = origin) => {
    const result = new URL("/", base);
    result.searchParams.set("archive", kind);
    return result.href;
  };
  const directoryTags = (kind, base = origin) => {
    const directory = directories[kind];
    return directory ? [
      ['meta[name="description"]', directory.description || homeDescription],
      ['meta[property="og:title"]', directory.title],
      ['meta[name="twitter:title"]', directory.title],
      ['meta[property="og:url"]', directoryUrl(kind, base)]
    ] : [];
  };
  const description = profile => String(profile.bio || profile.name || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const queerFlags = { artist: "queerArtist", venue: "queerVenue", party: "queerParty", collective: "queerCollective" };
  const isQueer = (kind, profile) => Boolean(queerFlags[kind] && profile?.[queerFlags[kind]] === true);
  const classification = (kind, profile) => {
    const labels = [];
    if (isQueer(kind, profile)) labels.push(`Queer ${kind}.`);
    if (kind === "artist" && profile.transArtist === true) labels.push("Trans artist.");
    return labels.join(" ");
  };
  const tags = (kind, profile, base = origin) => [
    ['meta[name="description"]', description(profile)],
    ['meta[property="og:title"]', title(profile)],
    ['meta[name="twitter:title"]', title(profile)],
    ['meta[property="og:description"]', description(profile)],
    ['meta[name="twitter:description"]', description(profile)],
    ['meta[property="og:url"]', url(kind, profile.id, base)],
    ['meta[property="og:image"]', new URL("/qdp-share-card.jpg", base).href],
    ['meta[name="twitter:image"]', new URL("/qdp-share-card.jpg", base).href],
    ['meta[property="og:image:alt"]', "Queer Dance Philly — find the next move"]
  ];
  globalThis.QDPProfileMetadata = Object.freeze({ origin, kinds, validId, url, title, artistImage, description, isQueer, classification, tags,
    homeDescription, directories, directoryUrl, directoryTags });
})();
