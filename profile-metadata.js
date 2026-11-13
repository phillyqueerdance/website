// Shared metadata for the approved profiles in Discover.
(() => {
  const origin = "https://queerdancephilly.com";
  const kinds = Object.freeze({ artist: "artists", venue: "venues", party: "parties", collective: "collectives" });
  const homeDescription = "Queer Philadelphia's guide to finding the next move. Discover queer dance parties, LGBTQ+ nightlife, DJs, artists, venues, and more!";
  const directories = Object.freeze({
    artists: Object.freeze({ kind: "artist", title: "Queer Dance Philly | Artists",
      description: "Discover DJs and artists across Philadelphia's dance music scene: upcoming sets, past appearances, and the parties and venues connecting them." }),
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
  const profileLinks = (kind, profile, base = origin) => {
    const links = [];
    for (const [key, label] of [["maps", "Map"], ["website", "Website"],
      ["instagram", "Instagram"], ["music", "Music"]]) {
      const href = globalThis.QDPEventMetadata.safeUrl(profile[key]);
      if (href) links.push({ href, label, external: true });
    }
    if (Object.hasOwn(kinds, kind) && validId(profile.id)) {
      const mapUrl = new URL("/", base);
      mapUrl.searchParams.set("archive", "scene-map");
      mapUrl.searchParams.set("focus", `${kind}:${profile.id}`);
      links.push({ href: mapUrl.href, label: "See in discovery map", external: false });
    }
    return links;
  };
  const title = profile => `${profile.name} | Queer Dance Philly`;
  const profileImage = (kind, profile) => {
    if (kind !== "artist" && kind !== "party" && kind !== "venue") return null;
    if (Object.hasOwn(profile, "imageUrl")) {
      const src = globalThis.QDPEventMetadata.image({ flyerUrl: profile.imageUrl });
      return src ? { src } : null;
    }
    // Keep the preview portrait only until the publisher supplies the new field.
    return kind === "artist" && profile.id === "CALLAIA-001"
      ? { src: "/artist-images/callaia.jpg", width: 2048, height: 2016 } : null;
  };
  const profileThumbnail = (kind, profile, width = 320) => {
    const image = profileImage(kind, profile);
    return image ? image.src.replace(/^(https:\/\/lh3\.googleusercontent\.com\/d\/[\w-]+)=w\d+$/, `$1=w${width}`) : "";
  };
  const directoryPhotoLoading = index => index < 6 ? "eager" : "lazy";
  const maxPhotoZoom = 4;
  const photoCrop = value => {
    const { x, y, zoom, aspect } = value || {};
    if (![x, y, zoom, aspect].every(Number.isFinite) || x < 0 || x > 1 ||
        y < 0 || y > 1 || zoom < 1 || zoom > maxPhotoZoom || aspect < 1 / 40 || aspect > 40) return null;
    return { x, y, zoom, aspect };
  };
  // Coordinates are in units of the square crop. Position spans the available pan range.
  const photoCropFrame = value => {
    const crop = photoCrop(value);
    if (!crop) return null;
    const width = Math.max(1, crop.aspect) * crop.zoom;
    const height = Math.max(1, 1 / crop.aspect) * crop.zoom;
    return { width, height, x: (width - 1) * crop.x, y: (height - 1) * crop.y };
  };
  const photoCropStyle = value => {
    const frame = photoCropFrame(value);
    if (!frame) return "";
    return `--photo-width:${frame.width * 100}%;--photo-height:${frame.height * 100}%;--photo-left:${-frame.x * 100}%;--photo-top:${-frame.y * 100}%`;
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
  globalThis.QDPProfileMetadata = Object.freeze({ origin, kinds, validId, url, profileLinks, title, profileImage, profileThumbnail, description, isQueer, classification, tags,
    homeDescription, directories, directoryUrl, directoryTags, directoryPhotoLoading,
    maxPhotoZoom, photoCrop, photoCropFrame, photoCropStyle });
})();
