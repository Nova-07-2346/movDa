(function (root) {
  "use strict";

  const MAX_PAGES = 250;
  const MAX_PAGINATION_PAGES = 250;
  const MEDIA_EXTENSIONS = /\.(mp4|webm|ogg|m4v|mov)(?:$|[\s?#])/i;
  const QUALITY_PATTERN = /(?:^|\D)(2160|1440|1080|720|480|360|240)p?(?:\D|$)/i;

  function isMoviesDaHost(hostname) {
    const host = hostname.toLowerCase();
    return host === "moviesda.ski" || host.endsWith(".moviesda.ski") ||
      host === "moviezda.co" || host.endsWith(".moviezda.co") ||
      host === "moviezda.me" || host.endsWith(".moviezda.me");
  }

  function isDirectMedia(url) {
    try {
      return /\.(mp4|webm|ogg|m4v|mov)$/i.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  function getResolution(text) {
    const match = String(text).match(QUALITY_PATTERN);
    return match ? Number(match[1]) : 0;
  }

  function isPreDvd(text) {
    return /pre[\s._-]*dvd/i.test(String(text));
  }

  function getEpisodeKey(label) {
    const match = String(label).match(/\bseason[\s._-]*(\d+).*?\b(?:episodes?|epi|ep)[\s._-]*(\d+)/i);
    return match ? `episode:${match[1]}:${match[2]}` : "";
  }

  function parsePage(html, baseUrl, checkPagination) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = new Map();
    const directVideos = new Set();
    let pagination = null;

    if (checkPagination) {
      const paginationList = doc.querySelector("ul.pagination");
      if (paginationList) {
        const totalPagesElement = doc.querySelector("#totalPages");
        const totalPagesValue = totalPagesElement?.value ||
          totalPagesElement?.textContent ||
          totalPagesElement?.getAttribute("value") ||
          "";
        pagination = {
          found: true,
          totalPages: Math.max(1, Number.parseInt(String(totalPagesValue).match(/\d+/)?.[0] || "1", 10))
        };
      }
    }

    for (const element of doc.querySelectorAll("video[src], video source[src]")) {
      try {
        const url = new URL(element.getAttribute("src"), baseUrl).href;
        if (isDirectMedia(url)) directVideos.add(url);
      } catch {}
    }

    for (const anchor of doc.querySelectorAll("a[href]")) {
      if (anchor.closest("ul.pagination")) continue;
      const raw = anchor.getAttribute("href");
      if (!raw || raw.trim().startsWith("#")) continue;

      try {
        const parsed = new URL(raw, baseUrl);
        if (!["http:", "https:"].includes(parsed.protocol)) continue;
        if (parsed.href === baseUrl || (parsed.origin === new URL(baseUrl).origin && parsed.pathname === "/")) continue;
        if (/\/tamil-movies\/[a-z]\/?$/i.test(parsed.pathname)) continue;

        let label = (anchor.innerText || anchor.textContent || anchor.getAttribute("title") || "")
          .trim()
          .replace(/\s+/g, " ");
        const server = /download\s*server\s*[12]/i.test(label);
        if (server && /^download\s*server\s*1$/i.test(label)) {
          const resolution = getResolution(parsed.href);
          if (resolution) label = `${resolution}p`;
        }
          
        const item = {
          url: parsed.href,
          label: label || parsed.hostname + parsed.pathname,
          sameSite: parsed.origin === new URL(baseUrl).origin,
          videoHint: MEDIA_EXTENSIONS.test(label) || isDirectMedia(parsed.href) || /\.php(?:$|[?#])/i.test(parsed.href),
          server
        };

        if (!links.has(item.url)) links.set(item.url, item);
      } catch {}
    }

    return { links: [...links.values()], directVideos: [...directVideos], pagination };
  }

  function makeVideo(url, label, direct, sourceUrl) {
    return {
      url,
      label: label || "Video",
      resolution: getResolution(label) || getResolution(url),
      preDVD: isPreDvd(label) || isPreDvd(url),
      direct,
      sourceUrl: sourceUrl || ""
    };
  }

  async function fetchPageHtml(url) {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const response = await fetch(proxyUrl, {
      method: "GET",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      throw new Error(`CORS proxy returned HTTP ${response.status}`);
    }

    const data = await response.json();
    const upstreamStatus = Number(data.status?.http_code);
    if (upstreamStatus >= 400) {
      throw new Error(`Source returned HTTP ${upstreamStatus}`);
    }
    if (typeof data.contents !== "string") {
      throw new Error("CORS proxy response did not contain page content");
    }

    return data.contents;
  }

  async function crawl(inputUrl) {
    let start;
    try {
      start = new URL(inputUrl);
      if (!["http:", "https:"].includes(start.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported.");
    } catch (error) {
      return {
        inputUrl: String(inputUrl || ""),
        videos: [],
        stats: { pages: 0, links: 0, failedRequests: 0 },
        error: error.message
      };
    }

    const visited = new Set();
    const links = new Map();
    const videos = new Map();
    const videoIdentityKeys = new Set();
    let failedRequests = 0;
    let pageLimitReached = false;
    let paginationFound = false;
    let paginationTotalPages = 1;
    let paginationUrl = "";

    function addVideo(url, label, direct, sourceUrl) {
      try {
        const parsed = new URL(url);
        if (isMoviesDaHost(parsed.hostname) || videos.has(parsed.href)) return;
        const videoKey = getEpisodeKey(label) || parsed.href;
        if (videoIdentityKeys.has(videoKey)) return;
        videoIdentityKeys.add(videoKey);
        videos.set(parsed.href, makeVideo(parsed.href, label, direct, sourceUrl));
      } catch {}
    }

    
async function visit(rawUrl, inheritedLabel = "", depth = 0) {
    let page;

    try {
        page = new URL(rawUrl);

        if (!["http:", "https:"].includes(page.protocol)) return;
    } catch {
        return;
    }

    if (visited.has(page.href) || depth >= MAX_PAGES) return;
    if (visited.size >= MAX_PAGES) {
        pageLimitReached = true;
        return;
    }

    visited.add(page.href);

    if (isDirectMedia(page.href)) {
        addVideo(page.href, inheritedLabel || page.pathname.split("/").pop(), true, page.href);
        return;
    }

    try {
        const html = await fetchPageHtml(page.href);
        const parsed = parsePage(html, page.href, !paginationFound);
        if (parsed.pagination?.found) {
            paginationFound = true;
            paginationTotalPages = Math.min(parsed.pagination.totalPages, MAX_PAGINATION_PAGES);
            paginationUrl = page.href;
            console.info(`[get.js] Pagination found: ${paginationTotalPages} total pages.`);
        }

        parsed.links.forEach(link => links.set(link.url, link));

        parsed.directVideos.forEach(url =>
            addVideo(url, inheritedLabel || "Embedded video", true, page.href)
        );

        const serverLinks = parsed.links.filter(
            link => link.server && !visited.has(link.url)
        );

        const nextLinks = serverLinks.length
            ? serverLinks
            : parsed.links.filter(
                link => !visited.has(link.url) &&
                    (link.sameSite || link.videoHint)
            );

        for (const link of nextLinks) {
            const genericLabel = /^(?:download(?:\s*server\s*[12])?|(?:2160|1440|1080|720|480|360|240)p?)$/i
                .test(link.label);
            const label = link.server || genericLabel
                ? inheritedLabel || link.label
                : link.label;

            await visit(link.url, label, depth + 1);
        }

    } catch (error) {
        failedRequests++;

        if (
            !isMoviesDaHost(page.hostname) &&
            (getResolution(inheritedLabel) || MEDIA_EXTENSIONS.test(inheritedLabel))
        ) {
            addVideo(page.href, inheritedLabel, isDirectMedia(page.href), page.href);
        }
    }
}


    await visit(start.href);

    return {
      inputUrl: start.href,
      videos: [...videos.values()],
      stats: {
        pages: visited.size,
        links: links.size,
        failedRequests,
        pageLimitReached,
        ...(paginationFound ? {
          paginationFound: true,
          totalPaginationPages: paginationTotalPages,
          paginationUrl
        } : {})
      }
    };
  }

  async function GetAllVideoUrl(inputUrl) {
    const firstPage = await crawl(inputUrl);
    if (firstPage.error || !firstPage.stats.paginationFound) return firstPage;

    const totalPages = firstPage.stats.totalPaginationPages;
    const paginationUrl = new URL(firstPage.stats.paginationUrl || firstPage.inputUrl);
    const requestedPage = Number.parseInt(paginationUrl.searchParams.get("page") || "1", 10);
    paginationUrl.searchParams.delete("page");

    const results = [];
    if (requestedPage === 1) {
      results.push(firstPage);
    } else {
      const pageOneResult = await crawl(paginationUrl.href);
      if (pageOneResult.error) return pageOneResult;
      results.push(pageOneResult);
    }

    for (let pageNumber = 2; pageNumber <= totalPages; pageNumber++) {
      const pageUrl = new URL(paginationUrl.href);
      pageUrl.searchParams.set("page", String(pageNumber));
      console.info(`[get.js] Crawling pagination page ${pageNumber}/${totalPages}: ${pageUrl.href}`);
      const result = await crawl(pageUrl.href);
      if (result.error) {
        result.stats.failedRequests += results.reduce(
          (total, previous) => total + previous.stats.failedRequests,
          0
        );
        return {
          ...result,
          inputUrl: firstPage.inputUrl,
          videos: mergeVideos(results),
          stats: {
            ...result.stats,
            pages: results.reduce((total, previous) => total + previous.stats.pages, 0) + result.stats.pages,
            links: results.reduce((total, previous) => total + previous.stats.links, 0) + result.stats.links,
            pageLimitReached: results.some(previous => previous.stats.pageLimitReached) || result.stats.pageLimitReached,
            paginationFound: true,
            totalPaginationPages: totalPages,
            paginationUrl: paginationUrl.href
          }
        };
      }
      results.push(result);
    }

    return {
      inputUrl: firstPage.inputUrl,
      videos: mergeVideos(results),
      stats: {
        pages: results.reduce((total, result) => total + result.stats.pages, 0),
        links: results.reduce((total, result) => total + result.stats.links, 0),
        failedRequests: results.reduce((total, result) => total + result.stats.failedRequests, 0),
        pageLimitReached: results.some(result => result.stats.pageLimitReached),
        paginationFound: true,
        totalPaginationPages: totalPages,
        paginationUrl: paginationUrl.href,
        paginationPagesVisited: results.length
      }
    };
  }

  function mergeVideos(results) {
    const videos = new Map();
    for (const result of results) {
      for (const video of result.videos) {
        const key = getEpisodeKey(video.label) || video.url;
        if (!videos.has(key)) videos.set(key, video);
      }
    }
    return [...videos.values()];
  }

  async function GetQuickVideoUrl(inputUrl) {
    const result = await GetAllVideoUrl(inputUrl);
    const nonPreDvd = result.videos.filter(video => !video.preDVD);
    const choices = nonPreDvd.length ? nonPreDvd : result.videos;
    choices.sort((a, b) => b.resolution - a.resolution);

    return {
      inputUrl: result.inputUrl,
      video: choices[0] || null,
      selection: choices.length
        ? nonPreDvd.length
          ? "highest available resolution excluding PRE-DVD when alternatives exist"
          : "only PRE-DVD candidates were available"
        : "no video URL found",
      stats: result.stats,
      ...(result.error ? { error: result.error } : {})
    };
  }

  root.GetQuickVideoUrl = GetQuickVideoUrl;
  root.GetAllVideoUrl = GetAllVideoUrl;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { GetQuickVideoUrl, GetAllVideoUrl };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);