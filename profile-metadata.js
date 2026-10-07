// Shared metadata for the approved profiles in Discover.
(() => {
  const origin = "https://queerdancephilly.com";
  const kinds = Object.freeze({ artist: "artists", venue: "venues", party: "parties", collective: "collectives" });
  const validId = id => typeof id === "string" && /^[\w-]{1,80}$/.test(id);
  const url = (kind, id, base = origin) => {
    const result = new URL("/", base);
    result.searchParams.set("archive", kind);
    result.searchParams.set("id", id);
    return result.href;
  };
  const title = profile => `${profile.name} | Queer Dance Philly`;
  const description = profile => String(profile.bio || profile.name || "").replace(/\s+/g, " ").trim().slice(0, 180);
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
  globalThis.QDPProfileMetadata = Object.freeze({ origin, kinds, validId, url, title, description, tags });
})();
