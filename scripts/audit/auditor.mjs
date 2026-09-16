import fs from "node:fs/promises";
import axe from "axe-core";
import { chromium } from "playwright-core";
import {
  analyzeCapitalization,
  CAPITALIZATION_STYLE_LABELS,
  hasConsistentListPunctuation,
  isInternalLink,
  isSentenceCase,
  makeResult,
  normalizeUrl,
  urlSlugProblems
} from "./checks.mjs";

const DEFAULT_VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
  { name: "large desktop", width: 1920, height: 1080 }
];

const PLACEHOLDER_PATTERN = /\b(lorem ipsum|placeholder text|sample text|test content|todo:|tbd\b)\b/i;
const DEFAULT_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
];

async function browserExecutable() {
  if (process.env.AUDIT_BROWSER_PATH) return process.env.AUDIT_BROWSER_PATH;
  for (const candidate of DEFAULT_CHROME_PATHS) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

function summarize(items, limit = 8) {
  if (!items.length) return "";
  const shown = items.slice(0, limit);
  return `${shown.join("; ")}${items.length > limit ? `; and ${items.length - limit} more` : ""}`;
}

async function checkLinks(context, links, maxLinks, timeout) {
  const unique = [...new Map(links.filter((link) => link.href).map((link) => [link.href, link])).values()];
  const selected = unique.slice(0, maxLinks);
  const failures = [];
  let cursor = 0;

  async function worker() {
    while (cursor < selected.length) {
      const link = selected[cursor++];
      let parsed;
      try { parsed = new URL(link.href); } catch { failures.push(`invalid URL: ${link.href}`); continue; }
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      try {
        const response = await context.request.get(parsed.toString(), { timeout, failOnStatusCode: false });
        if (response.status() >= 400) failures.push(`${response.status()} ${parsed.toString()}`);
      } catch (error) {
        failures.push(`${parsed.toString()} (${error.message.split('\n')[0]})`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(6, selected.length || 1) }, worker));
  return {
    failures,
    checked: selected.length,
    truncated: Math.max(0, unique.length - selected.length)
  };
}

async function pageSnapshot(page, contentSelector) {
  return page.evaluate((selector) => {
    const contentSection = document.querySelector(selector);
    const scope = contentSection || document.createElement('section');
    const all = (selector) => [...scope.querySelectorAll(selector)];
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();
    const doubleSpaceSamples = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (/\S {2,}\S/.test(node.nodeValue || '') && node.parentElement && visible(node.parentElement)) {
        doubleSpaceSamples.push(clean(node.nodeValue).slice(0, 120));
      }
    }
    const capitalizationItems = [];
    const capitalizationElements = new Set();
    const addCapitalizationItem = (element, source, text = '') => {
      if (!element || capitalizationElements.has(element) || !visible(element)) return;
      if (element.matches('figcaption') || element.closest('figcaption')) return;
      if ([...capitalizationElements].some((existing) => element.contains(existing))) return;
      const label = clean(text || element.innerText || element.value || element.getAttribute('aria-label'));
      const wordCount = (label.match(/[\p{L}\p{N}][\p{L}\p{N}'’&/-]*/gu) || []).length;
      if (wordCount < 2 || wordCount > 16 || label.length > 140) return;
      capitalizationElements.add(element);
      capitalizationItems.push({ text: label, source });
    };
    for (const heading of all('h1,h2,h3,h4,h5,h6')) addCapitalizationItem(heading, `${heading.tagName} title`);
    for (const button of all('button,input[type="button"],input[type="submit"],input[type="reset"],[role="button"],a.button,a.btn,a[class*="button"]')) {
      addCapitalizationItem(button, 'button');
    }
    for (const title of all('legend,summary,dt,[data-title],[class*="title" i]')) {
      addCapitalizationItem(title, title.tagName === 'DT' ? 'list title' : 'title');
    }
    const figureCaptions = all('figcaption').filter(visible).map((caption, index) => ({
      text: clean(caption.innerText),
      source: `figure caption ${index + 1}`
    })).filter((caption) => caption.text);
    for (const item of all('li')) {
      const explicitTitle = item.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6,:scope > strong,:scope > b,:scope > a,:scope > button,:scope > [class*="title" i],:scope > p > strong:first-child,:scope > p > b:first-child');
      if (explicitTitle) {
        addCapitalizationItem(explicitTitle, 'list title');
        continue;
      }
      const clone = item.cloneNode(true);
      clone.querySelectorAll('ul,ol').forEach((nestedList) => nestedList.remove());
      const label = clean(clone.textContent);
      const wordCount = (label.match(/[\p{L}\p{N}][\p{L}\p{N}'’&/-]*/gu) || []).length;
      if (wordCount >= 2 && wordCount <= 10 && label.length <= 100 && !/[.!?]$/.test(label)) {
        addCapitalizationItem(item, 'list title', label);
      }
    }
    const listGroups = all('ul,ol').map((list) =>
      [...list.children].filter((child) => child.matches('li')).map((item) => clean(item.innerText)).filter(Boolean)
    );
    const headings = all('h1,h2,h3,h4,h5,h6').filter(visible).map((heading) => ({
      level: Number(heading.tagName.slice(1)), text: clean(heading.innerText)
    }));
    const images = all('img').filter(visible).map((image) => ({
      src: image.currentSrc || image.src,
      altPresent: image.hasAttribute('alt'),
      alt: image.getAttribute('alt'),
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      renderedWidth: Math.round(image.getBoundingClientRect().width),
      renderedHeight: Math.round(image.getBoundingClientRect().height)
    }));
    const links = all('a').filter(visible).map((anchor) => ({
      text: clean(anchor.innerText || anchor.getAttribute('aria-label')),
      href: anchor.href,
      rawHref: anchor.getAttribute('href'),
      target: anchor.getAttribute('target'),
      clickable: getComputedStyle(anchor).pointerEvents !== 'none' && anchor.getBoundingClientRect().width > 0
    }));
    const controls = all('button,input[type="button"],input[type="submit"]').filter(visible).map((control) => ({
      label: clean(control.innerText || control.value || control.getAttribute('aria-label')),
      disabled: control.disabled || control.getAttribute('aria-disabled') === 'true',
      clickable: getComputedStyle(control).pointerEvents !== 'none'
    }));
    const fontGroups = {};
    for (const element of all('h1,h2,h3,h4,h5,h6,p,li,button').filter(visible)) {
      const group = /^H[1-6]$/.test(element.tagName) ? 'headings' : element.tagName === 'BUTTON' ? 'buttons' : 'body text';
      const family = getComputedStyle(element).fontFamily.replace(/["']/g, '').trim();
      fontGroups[group] ||= {};
      fontGroups[group][family] = (fontGroups[group][family] || 0) + 1;
    }
    const videos = all('video').filter(visible).map((video) => ({
      source: video.currentSrc || video.src,
      captionTracks: video.querySelectorAll('track[kind="captions"],track[kind="subtitles"]').length
    }));
    const videoIframes = all('iframe').filter(visible).filter((frame) => /youtube|youtu\.be|vimeo|video/i.test(frame.src));
    const forms = all('form').filter(visible).map((form) => {
      const fields = [...form.querySelectorAll('input,select,textarea')].filter((field) => !['hidden', 'submit', 'button'].includes(field.type));
      const unlabeled = fields.filter((field) => {
        const idLabel = field.id && document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        return !idLabel && !field.closest('label') && !field.getAttribute('aria-label') && !field.getAttribute('aria-labelledby');
      });
      return {
        action: form.action,
        method: (form.method || 'get').toUpperCase(),
        fields: fields.length,
        unlabeled: unlabeled.length,
        hasSubmit: Boolean(form.querySelector('button[type="submit"],input[type="submit"],button:not([type])'))
      };
    });
    const mainAssetUrls = new Set(all('[src]').map((element) => element.currentSrc || element.src).filter(Boolean));
    const imageResources = performance.getEntriesByType('resource').filter((entry) => entry.initiatorType === 'img' && mainAssetUrls.has(entry.name)).map((entry) => ({
      name: entry.name,
      transferSize: entry.transferSize || 0,
      decodedBodySize: entry.decodedBodySize || 0
    }));
    const headMetaTags = [...(document.head?.querySelectorAll('meta') || [])];
    const descriptionTag = headMetaTags.find((tag) => (tag.getAttribute('name') || '').trim().toLowerCase() === 'description');
    const openGraphDescriptionTag = headMetaTags.find((tag) => (tag.getAttribute('property') || '').trim().toLowerCase() === 'og:description');
    const description = descriptionTag?.getAttribute('content')?.trim() || '';
    const openGraphDescription = openGraphDescriptionTag?.getAttribute('content')?.trim() || '';
    return {
      hasContentSection: Boolean(contentSection),
      title: document.title.trim(),
      description,
      descriptionStatus: descriptionTag ? (description ? 'present' : 'empty') : (openGraphDescription ? 'open-graph-only' : 'missing'),
      bodyText: contentSection?.innerText || '',
      bodyHtml: contentSection?.innerHTML || '',
      capitalizationItems, figureCaptions, listGroups, headings, images, links, controls, fontGroups, doubleSpaceSamples,
      videos, videoIframeCount: videoIframes.length, forms, imageResources, mainAssetUrls: [...mainAssetUrls]
    };
  }, contentSelector);
}

export async function auditUrl(inputUrl, options = {}) {
  const url = normalizeUrl(inputUrl);
  const contentSelector = options.contentSelector ?? 'section#MainSection';
  const timeout = options.timeout ?? 30_000;
  const maxLinks = options.maxLinks ?? 100;
  const failedResponses = [];
  const executablePath = await browserExecutable();
  const browser = await chromium.launch({
    headless: !options.headed,
    executablePath,
    args: ["--disable-dev-shm-usage"]
  });

  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: false });
    const page = await context.newPage();
    page.on('response', (response) => {
      if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
    });

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    if (!response) throw new Error(`The page did not return a navigation response: ${url}`);
    if (response.status() >= 400) throw new Error(`The page returned HTTP ${response.status()}: ${url}`);
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 5_000) }).catch(() => {});
    await page.addScriptTag({ content: axe.source });
    const snapshot = await pageSnapshot(page, contentSelector);
    const results = [];

    results.push(makeResult(
      "main-content",
      "Main content section",
      snapshot.hasContentSection ? "pass" : "fail",
      snapshot.hasContentSection ? `Found ${contentSelector}; page-content checks are limited to it.` : `No element matching ${contentSelector} was found, so page-content checks had no auditable scope.`,
      `Ensure the content element matches the configured selector: ${contentSelector}.`
    ));
    const scopedResult = (id, label, status, details, suggestion = "") => makeResult(
      id,
      label,
      snapshot.hasContentSection ? status : "skipped",
      snapshot.hasContentSection ? details : `Skipped because the page has no ${contentSelector} element.`,
      snapshot.hasContentSection ? suggestion : ""
    );

    const capitalization = analyzeCapitalization(snapshot.capitalizationItems);
    const capitalizationCounts = Object.entries(capitalization.counts)
      .map(([style, count]) => `${count} ${CAPITALIZATION_STYLE_LABELS[style]}`)
      .join(", ");
    const majorityStyle = capitalization.recommendedStyle && CAPITALIZATION_STYLE_LABELS[capitalization.recommendedStyle];
    const describeCapitalizationOutlier = (item) => {
      const apaFixes = capitalization.recommendedStyle === "title"
        ? item.titleCaseIssues.map((issue) => `${issue.expected} “${issue.word}”`)
        : [];
      const apaNote = apaFixes.length ? `; APA fixes: ${apaFixes.join(", ")}` : "";
      return `${item.source} “${item.text}” (${CAPITALIZATION_STYLE_LABELS[item.style]}${apaNote})`;
    };
    const capitalizationDetails = capitalization.consistent
      ? (capitalization.eligible.length
        ? `Consistent: all ${capitalization.eligible.length} checked labels use ${CAPITALIZATION_STYLE_LABELS[capitalization.eligible[0].style]}.`
        : "No multi-word headings, buttons, or list titles were available to compare.")
      : `Found ${capitalizationCounts}. ${majorityStyle ? `Most common: ${majorityStyle}. Labels to change: ${summarize(capitalization.outliers.map(describeCapitalizationOutlier))}` : "No single style is more common; choose one style and apply it to every checked label."}`;
    const capitalizationSuggestion = capitalization.consistent
      ? "Keep headings, buttons, and list titles in the same capitalization style."
      : (majorityStyle
        ? `Use ${majorityStyle} for all headings, buttons, and list titles because it is the most common style (${capitalization.recommendedCount} of ${capitalization.eligible.length}).${capitalization.recommendedStyle === "title" ? " APA Title Case capitalizes major words and all words of four letters or more, while lowercasing articles and short conjunctions/prepositions unless they begin a title, subtitle, or new part after punctuation." : ""}`
        : "There is a tie between capitalization styles. Choose one style—preferably Title Case or Sentence case—and apply it to every heading, button, and list title.");
    results.push(scopedResult(
      "capitalization",
      "Capitalization consistency",
      capitalization.consistent ? "pass" : "fail",
      capitalizationDetails,
      capitalizationSuggestion
    ));

    const figureCaptionFailures = snapshot.figureCaptions.filter((caption) => !isSentenceCase(caption.text));
    results.push(scopedResult(
      "figure-caption-capitalization",
      "Figure caption capitalization",
      figureCaptionFailures.length ? "fail" : "pass",
      snapshot.figureCaptions.length
        ? (figureCaptionFailures.length
          ? `Figure captions that are not sentence case: ${summarize(figureCaptionFailures.map((caption) => `${caption.source} “${caption.text}”`))}`
          : `All ${snapshot.figureCaptions.length} visible figure captions use sentence case.`)
        : "No visible figure captions were found inside section#MainSection."
    ));

    const doubleSpaces = snapshot.doubleSpaceSamples.length;
    const breakRuns = (snapshot.bodyHtml.match(/(?:<br\s*\/?>\s*){3,}/gi) || []).length;
    const fontOutliers = [];
    for (const [group, families] of Object.entries(snapshot.fontGroups)) {
      const sorted = Object.entries(families).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 1 && sorted[0][1] >= 2) {
        for (const [family, count] of sorted.slice(1)) if (count === 1) fontOutliers.push(`${group}: ${family}`);
      }
    }
    const typographyIssues = [
      doubleSpaces ? `${doubleSpaces} double-space occurrence(s)` : "",
      breakRuns ? `${breakRuns} excessive line-break run(s)` : "",
      fontOutliers.length ? `possible font outlier(s): ${summarize(fontOutliers, 4)}` : ""
    ].filter(Boolean);
    results.push(scopedResult("typography", "Grammar & typography", typographyIssues.length ? "fail" : "pass",
      typographyIssues.length ? typographyIssues.join("; ") : "No double spaces, excessive break runs, or isolated font-family outliers found."));

    const inconsistentLists = snapshot.listGroups.filter((items) => !hasConsistentListPunctuation(items));
    results.push(scopedResult("list-punctuation", "List punctuation", inconsistentLists.length ? "fail" : "pass",
      inconsistentLists.length ? `${inconsistentLists.length} list(s) mix terminal punctuation.` : "List punctuation is consistent."));

    results.push(makeResult("ai-verification", "AI verification", "skipped", "Manual content-origin verification requested to be skipped."));

    const missingAlt = snapshot.images.filter((image) => !image.altPresent);
    results.push(scopedResult("image-alt", "Image alt text", missingAlt.length ? "fail" : "pass",
      missingAlt.length ? summarize(missingAlt.map((image) => image.src)) : `All ${snapshot.images.length} visible image(s) have an alt attribute; empty alt is treated as decorative.`));

    const headingProblems = [];
    if (!snapshot.headings.length) headingProblems.push("no visible headings found");
    else if (snapshot.headings[0].level !== 1) headingProblems.push(`first heading is H${snapshot.headings[0].level}`);
    const h1Count = snapshot.headings.filter((heading) => heading.level === 1).length;
    if (snapshot.headings.length && h1Count === 0) headingProblems.push("no H1 heading found");
    if (h1Count > 1) headingProblems.push(`${h1Count} H1 headings found`);
    for (let i = 1; i < snapshot.headings.length; i += 1) {
      if (snapshot.headings[i].level > snapshot.headings[i - 1].level + 1) {
        headingProblems.push(`H${snapshot.headings[i - 1].level} “${snapshot.headings[i - 1].text}” jumps to H${snapshot.headings[i].level} “${snapshot.headings[i].text}”`);
      }
    }
    results.push(scopedResult("heading-structure", "Heading structure", headingProblems.length ? "fail" : "pass",
      headingProblems.length ? summarize(headingProblems) : `Checked ${snapshot.headings.length} heading(s); no level skips found.`));

    const axeResult = snapshot.hasContentSection ? await page.evaluate(async (selector) => window.axe.run(document.querySelector(selector), {
      runOnly: { type: 'rule', values: ['color-contrast'] }
    }), contentSelector) : { violations: [] };
    const contrastNodes = axeResult.violations.flatMap((violation) => violation.nodes);
    results.push(scopedResult("color-contrast", "Color contrast", contrastNodes.length ? "fail" : "pass",
      contrastNodes.length ? `${contrastNodes.length} element(s) fail axe color-contrast rules.` : "No automated WCAG color-contrast violations found."));
    results.push(makeResult("wave", "WAVE plug-in", "skipped", "The WAVE browser extension requires a manual run; axe contrast testing is included separately."));

    const emptyLinks = snapshot.links.filter((link) => !link.rawHref || link.rawHref === '#');
    const unclickable = snapshot.links.filter((link) => !link.clickable).map((link) => link.text || link.href)
      .concat(snapshot.controls.filter((control) => !control.clickable || control.disabled).map((control) => control.label || "unlabelled control"));
    const linkCheck = await checkLinks(context, snapshot.links, maxLinks, Math.min(timeout, 15_000));
    const clickIssues = [
      ...emptyLinks.map((link) => `empty/# link “${link.text || 'unlabelled'}”`),
      ...unclickable.map((label) => `not clickable: “${label}”`),
      ...linkCheck.failures
    ];
    results.push(scopedResult("clickable-functionality", "Clickable functionality", clickIssues.length ? "fail" : "pass",
      clickIssues.length ? summarize(clickIssues) : `Checked ${linkCheck.checked} unique link destination(s) and ${snapshot.controls.length} button(s).${linkCheck.truncated ? ` ${linkCheck.truncated} link(s) skipped due to the limit.` : ""}`));

    const targetIssues = snapshot.links.filter((link) => {
      if (!link.href || !/^https?:/i.test(link.href)) return false;
      const parsed = new URL(link.href);
      const isExternal = !isInternalLink(page.url(), parsed.toString());
      const isPdf = /\.pdf(?:$|[?#])/i.test(parsed.pathname + parsed.search + parsed.hash);
      return (isExternal || isPdf) ? link.target !== '_blank' : link.target === '_blank';
    });
    results.push(scopedResult("link-targets", "External links & documents", targetIssues.length ? "fail" : "pass",
      targetIssues.length ? summarize(targetIssues.map((link) => `${link.href} uses target=${link.target || '(same tab)'}`)) : "External/PDF links open in a new tab and internal links stay in the same tab."));

    const mainAssetUrls = new Set(snapshot.mainAssetUrls);
    const assetFailures = failedResponses
      .filter((entry) => mainAssetUrls.has(entry.url))
      .map((entry) => `${entry.status} ${entry.url}`);
    const componentIssues = [...new Set(assetFailures)];
    results.push(scopedResult("components", "Components & assets", componentIssues.length ? "fail" : "pass",
      componentIssues.length ? summarize(componentIssues) : "No failed assets referenced inside section#MainSection were observed."));
    results.push(scopedResult("component-headings", "Component heading levels", headingProblems.length ? "fail" : "pass",
      headingProblems.length ? "Uses the page-wide heading hierarchy result." : "Component headings do not create hierarchy skips."));

    const responsiveIssues = [];
    const testedViewports = options.viewports || DEFAULT_VIEWPORTS;
    for (const viewport of testedViewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(150);
      const overflow = await page.evaluate((selector) => {
        const contentSection = document.querySelector(selector);
        if (!contentSection) return { rootOverflow: 0, offenders: [] };
        const visibleLeft = 0;
        const visibleRight = document.documentElement.clientWidth;
        const rootOverflow = Math.max(
          0,
          document.documentElement.scrollWidth - visibleRight
        );
        const offenders = [...contentSection.querySelectorAll('*')].filter((element) => {
          const style = getComputedStyle(element);
          if (style.position === 'fixed' || style.position === 'absolute') return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.right > visibleRight + 2 || rect.left < visibleLeft - 2);
        }).slice(0, 5).map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`);
        return { rootOverflow, offenders };
      }, contentSelector);
      if (overflow.rootOverflow > 2) responsiveIssues.push(`${viewport.name} (${viewport.width}px): ${Math.round(overflow.rootOverflow)}px horizontal overflow near ${overflow.offenders.join(', ') || 'unknown element'}`);
    }
    results.push(scopedResult("responsive", "Responsive design", responsiveIssues.length ? "fail" : "pass",
      responsiveIssues.length ? summarize(responsiveIssues) : `No horizontal overflow at ${testedViewports.map((item) => `${item.width}px`).join(', ')}.`));

    const imageIssues = snapshot.images.filter((image) => image.naturalWidth > image.renderedWidth * 2.5 && image.naturalWidth - image.renderedWidth > 500)
      .map((image) => `${image.src} is ${image.naturalWidth}px wide but renders at ${image.renderedWidth}px`);
    for (const resource of snapshot.imageResources) {
      const bytes = resource.transferSize || resource.decodedBodySize;
      if (bytes > 500_000) imageIssues.push(`${resource.name} transfers ${(bytes / 1_000_000).toFixed(1)} MB`);
    }
    results.push(scopedResult("image-optimization", "Image optimization", imageIssues.length ? "fail" : "pass",
      imageIssues.length ? summarize(imageIssues) : "No image above 500 KB or substantially oversized raster dimensions was measurable."));

    const metadataIssues = [];
    if (!snapshot.title) metadataIssues.push("missing page title");
    if (snapshot.descriptionStatus === "missing") metadataIssues.push("missing <meta name=\"description\"> tag in <head>");
    else if (snapshot.descriptionStatus === "empty") metadataIssues.push("meta description tag is present in <head>, but its content is empty");
    else if (snapshot.descriptionStatus === "open-graph-only") metadataIssues.push("standard meta description is missing; found only an og:description tag");
    else if (snapshot.description.length < 50 || snapshot.description.length > 160) metadataIssues.push(`meta description is ${snapshot.description.length} characters (recommended 50–160)`);
    if (PLACEHOLDER_PATTERN.test(snapshot.title) || PLACEHOLDER_PATTERN.test(snapshot.description)) metadataIssues.push("placeholder text in metadata");
    results.push(makeResult("metadata", "Metadata", metadataIssues.length ? "fail" : "pass",
      metadataIssues.length ? metadataIssues.join("; ") : `Title and ${snapshot.description.length}-character meta description are present.`));

    const placeholderMatches = snapshot.bodyText.split(/\n+/).filter((line) => PLACEHOLDER_PATTERN.test(line));
    results.push(scopedResult("test-data", "Test data removal", placeholderMatches.length ? "fail" : "pass",
      placeholderMatches.length ? summarize(placeholderMatches.map((line) => line.trim())) : "No common placeholder/test-content markers found."));

    const slugIssues = urlSlugProblems(page.url());
    results.push(makeResult("url-structure", "URL structure", slugIssues.length ? "fail" : "pass",
      slugIssues.length ? slugIssues.join("; ") : "Path uses lowercase, readable URL characters without spaces or underscores."));

    results.push(makeResult("branding", "Branding & visuals (section 6)", "skipped", "Entire section skipped as requested."));

    const missingTracks = snapshot.videos.filter((video) => video.captionTracks === 0);
    if (!snapshot.videos.length && !snapshot.videoIframeCount) {
      results.push(scopedResult("video-accessibility", "Video accessibility", "pass", "No embedded videos detected."));
    } else if (missingTracks.length) {
      results.push(scopedResult("video-accessibility", "Video accessibility", "fail", `${missingTracks.length} HTML video(s) have no captions/subtitles track.`));
    } else if (snapshot.videoIframeCount) {
      results.push(scopedResult("video-accessibility", "Video accessibility", "skipped", `${snapshot.videoIframeCount} third-party video iframe(s) require manual caption/transcript verification.`));
    } else {
      results.push(scopedResult("video-accessibility", "Video accessibility", "pass", "Every HTML video has a captions or subtitles track."));
    }

    const formIssues = snapshot.forms.flatMap((form, index) => {
      const issues = [];
      if (!form.hasSubmit) issues.push(`form ${index + 1} has no submit control`);
      if (form.unlabeled) issues.push(`form ${index + 1} has ${form.unlabeled} unlabeled field(s)`);
      if (!form.action) issues.push(`form ${index + 1} has no action URL`);
      return issues;
    });
    if (!snapshot.forms.length) {
      results.push(scopedResult("forms", "Form testing", "pass", "No forms detected."));
    } else if (formIssues.length) {
      results.push(scopedResult("forms", "Form testing", "fail", `${summarize(formIssues)} Live submission was not attempted.`));
    } else {
      results.push(scopedResult("forms", "Form testing", "skipped", `${snapshot.forms.length} form(s) pass structural checks; live submission is intentionally not attempted.`));
    }

    for (const result of results) {
      for (const field of ['scope', 'details', 'suggestion']) {
        result[field] = result[field]?.replaceAll('section#MainSection', contentSelector);
      }
    }

    return {
      url: page.url(),
      title: snapshot.title || "Untitled page",
      auditedAt: new Date().toISOString(),
      results,
      summary: {
        passed: results.filter((result) => result.status === "pass").length,
        failed: results.filter((result) => result.status === "fail").length,
        skipped: results.filter((result) => result.status === "skipped").length
      }
    };
  } finally {
    await browser.close();
  }
}
