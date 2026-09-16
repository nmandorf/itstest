const TERMINAL_PUNCTUATION = /[.!?;:]$/;
// APA 7 title case lowercases only articles and short (three letters or fewer)
// conjunctions/prepositions, unless they begin the title/subtitle or follow
// punctuation that starts a new part of a heading. Four-letter words such as
// "From" and "With" are always major words.
const APA_MINOR_TITLE_WORDS = new Set([
  "a", "an", "the",
  "and", "as", "but", "for", "if", "nor", "or", "so", "yet",
  "at", "by", "in", "of", "off", "on", "per", "to", "up", "via"
]);
const APA_NEW_PART_SEPARATOR = /[:.!?]|\u2014/u;

export const CHECK_GUIDANCE = {
  "main-content": { section: "Audit scope", scope: "Page structure", suggestion: "Add <section id=\"MainSection\"> around the page-specific content, then run the audit again." },
  capitalization: { section: "1. Content & Formatting", scope: "section#MainSection only", suggestion: "Use either Title Case or sentence case consistently for headings and buttons inside section#MainSection." },
  "figure-caption-capitalization": { section: "1. Content & Formatting", scope: "Visible figcaption elements in section#MainSection", suggestion: "Rewrite every figure caption in sentence case: capitalize its opening word, then lowercase ordinary words except proper nouns and acronyms." },
  typography: { section: "1. Content & Formatting", scope: "section#MainSection only", suggestion: "Remove doubled spaces or extra line breaks and reset any one-off pasted font styling inside section#MainSection." },
  "list-punctuation": { section: "1. Content & Formatting", scope: "section#MainSection only", suggestion: "Make every item in each affected list end with punctuation, or remove punctuation from every item in that list." },
  "ai-verification": { section: "1. Content & Formatting", scope: "Skipped", suggestion: "Manual check intentionally excluded." },
  "image-alt": { section: "2. Accessibility", scope: "section#MainSection only", suggestion: "Add descriptive alt text to meaningful images; use alt=\"\" only for decorative images." },
  "heading-structure": { section: "2. Accessibility", scope: "section#MainSection only", suggestion: "Start with one H1 and change headings so levels proceed without skips (H1 → H2 → H3)." },
  "color-contrast": { section: "2. Accessibility", scope: "section#MainSection only", suggestion: "Change the foreground or background colors on the affected section#MainSection elements until they meet WCAG contrast requirements." },
  wave: { section: "2. Accessibility", scope: "Skipped", suggestion: "Run the WAVE browser extension manually." },
  "clickable-functionality": { section: "3. Links & Navigation", scope: "section#MainSection only", suggestion: "Repair or remove each listed link/button and confirm the destination returns a successful response." },
  "link-targets": { section: "3. Links & Navigation", scope: "section#MainSection only", suggestion: "Use target=\"_blank\" for external/PDF links and the same tab for internal links." },
  components: { section: "4. Component Checks", scope: "section#MainSection only", suggestion: "Repair or replace the listed failed asset used inside section#MainSection, then reload the page and retest the component." },
  "component-headings": { section: "4. Component Checks", scope: "section#MainSection only", suggestion: "Set each component heading option to the next valid level in the section#MainSection heading hierarchy." },
  responsive: { section: "5. Technical & Responsive Design", scope: "section#MainSection only", suggestion: "Adjust the listed section#MainSection element’s width, wrapping, or responsive CSS so it does not overflow at that viewport." },
  "image-optimization": { section: "5. Technical & Responsive Design", scope: "section#MainSection only", suggestion: "Resize and compress the listed image, and serve an appropriately sized responsive variant." },
  metadata: { section: "5. Technical & Responsive Design", scope: "Page-level metadata", suggestion: "Add a clear page title and a specific meta description of roughly 50–160 characters." },
  "test-data": { section: "5. Technical & Responsive Design", scope: "section#MainSection only", suggestion: "Replace or remove the listed placeholder/test text inside section#MainSection." },
  "url-structure": { section: "5. Technical & Responsive Design", scope: "Page URL", suggestion: "Change the path to lowercase descriptive words separated by hyphens, then configure a redirect from the old URL." },
  branding: { section: "6. Branding & Visuals", scope: "Skipped", suggestion: "Entire section intentionally excluded." },
  "video-accessibility": { section: "7. Media & Interactions", scope: "section#MainSection only", suggestion: "Add a captions/subtitles track or a reviewed transcript for each affected video." },
  forms: { section: "7. Media & Interactions", scope: "section#MainSection only", suggestion: "Add the missing labels or submit control, then manually test a real submission and confirmation message." }
};

export function normalizeUrl(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("A URL is required.");
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("Only http:// and https:// URLs are supported.");
  }
  return url.toString();
}

export function hasConsistentListPunctuation(items) {
  const meaningful = items.map((item) => item.trim()).filter(Boolean);
  if (meaningful.length < 2) return true;
  const styles = meaningful.map((item) => TERMINAL_PUNCTUATION.test(item));
  return styles.every(Boolean) || styles.every((value) => !value);
}

function wordTokens(text) {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map((match) => ({
    word: match[0],
    start: match.index,
    end: match.index + match[0].length
  }));
}

function startsWithUppercase(word) {
  const firstLetter = word.match(/\p{L}/u)?.[0];
  return Boolean(firstLetter && firstLetter === firstLetter.toUpperCase());
}

export function apaTitleCaseIssues(label) {
  const text = String(label || "").trim();
  const tokens = wordTokens(text);

  return tokens.flatMap((token, index) => {
    if (!/\p{L}/u.test(token.word)) return [];
    const separator = index ? text.slice(tokens[index - 1].end, token.start) : "";
    const lower = token.word.toLocaleLowerCase("en-US");
    const startsNewPart = index === 0 || APA_NEW_PART_SEPARATOR.test(separator);
    const isMinor = APA_MINOR_TITLE_WORDS.has(lower);
    const shouldCapitalize = startsNewPart || !isMinor;
    const isCapitalized = startsWithUppercase(token.word);

    if (shouldCapitalize && !isCapitalized) {
      const reason = startsNewPart
        ? "it begins the title, subtitle, or a new part after punctuation"
        : (token.word.length >= 4 ? "APA capitalizes words of four letters or more" : "it is a major word");
      return [{ word: token.word, expected: "capitalize", reason }];
    }
    if (!shouldCapitalize && isCapitalized) {
      return [{ word: token.word, expected: "lowercase", reason: "it is an article or a short conjunction/preposition" }];
    }
    return [];
  });
}

export function classifyTextCase(label) {
  const text = String(label || "").trim();
  const words = wordTokens(text).map((token) => token.word);
  if (words.length < 2) return "neutral";
  const letters = text.match(/\p{L}/gu) || [];
  if (!letters.length) return "neutral";
  if (letters.every((letter) => letter === letter.toUpperCase())) return "uppercase";
  if (letters.every((letter) => letter === letter.toLowerCase())) return "lowercase";

  const titleIssues = apaTitleCaseIssues(text);
  const laterWords = words.slice(1).filter((word) => /\p{L}/u.test(word));
  const laterCapitalized = laterWords.filter((word) => startsWithUppercase(word) && !/^[\p{Lu}\d&'’/-]+$/u.test(word)).length;
  const firstIsUppercase = startsWithUppercase(words[0]);

  if (firstIsUppercase && titleIssues.length === 0) return "title";
  if (firstIsUppercase && laterCapitalized <= Math.max(0, Math.floor(laterWords.length * 0.2))) {
    return "sentence";
  }
  return "mixed";
}

export function isSentenceCase(label) {
  const text = String(label || "").trim();
  const words = wordTokens(text);
  const letters = text.match(/\p{L}/gu) || [];
  const firstWordWithLetters = words.find((token) => /\p{L}/u.test(token.word));
  if (!firstWordWithLetters || !letters.length || !startsWithUppercase(firstWordWithLetters.word)) return false;
  if (letters.every((letter) => letter === letter.toUpperCase())) return false;
  if (words.length === 1) return true;

  // A caption containing lowercase major words is visibly sentence-cased.
  // Proper nouns and acronyms may remain capitalized without causing a failure.
  return apaTitleCaseIssues(text).some((issue) => issue.expected === "capitalize");
}

export const CAPITALIZATION_STYLE_LABELS = {
  title: "Title Case",
  sentence: "Sentence case",
  uppercase: "ALL CAPS",
  lowercase: "lowercase",
  mixed: "mixed capitalization",
  neutral: "single-word/neutral"
};

export function analyzeCapitalization(items) {
  const classified = items.map((item, index) => {
    const normalized = typeof item === "string" ? { text: item, source: "label" } : item;
    return {
      ...normalized,
      index,
      style: classifyTextCase(normalized.text),
      titleCaseIssues: apaTitleCaseIssues(normalized.text)
    };
  });
  const eligible = classified.filter((item) => item.style !== "neutral");
  const counts = {};
  for (const item of eligible) counts[item.style] = (counts[item.style] || 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return eligible.findIndex((item) => item.style === a[0]) - eligible.findIndex((item) => item.style === b[0]);
  });
  const tiedForMost = ranked.length > 1 && ranked[0][1] === ranked[1][1];
  const recommendedStyle = ranked.length && !tiedForMost ? ranked[0][0] : null;
  return {
    classified,
    eligible,
    counts,
    consistent: ranked.length <= 1,
    recommendedStyle,
    recommendedCount: recommendedStyle ? counts[recommendedStyle] : 0,
    outliers: recommendedStyle ? eligible.filter((item) => item.style !== recommendedStyle) : eligible
  };
}

export function urlSlugProblems(urlString) {
  const url = new URL(urlString);
  const segments = decodeURIComponent(url.pathname).split('/').filter(Boolean);
  const problems = [];
  for (const segment of segments) {
    if (segment !== segment.toLowerCase()) problems.push(`uppercase characters in “${segment}”`);
    if (/[ _]/.test(segment)) problems.push(`spaces or underscores in “${segment}”`);
    if (!/^[a-z0-9.-]+$/.test(segment)) problems.push(`nonstandard characters in “${segment}”`);
  }
  return [...new Set(problems)];
}

function normalizedHostname(hostname) {
  return String(hostname || "").toLowerCase().replace(/^www\./, "");
}

export function isInternalLink(pageUrl, targetUrl) {
  const page = new URL(pageUrl);
  const target = new URL(targetUrl, page);
  const pageHost = normalizedHostname(page.hostname);
  const targetHost = normalizedHostname(target.hostname);
  if (pageHost === targetHost) return true;

  const isSmccdHost = (host) => host === "smccd.edu" || host.endsWith(".smccd.edu");
  const isInternationalPath = (pathname) => pathname === "/international" || pathname.startsWith("/international/");
  return isSmccdHost(pageHost)
    && isSmccdHost(targetHost)
    && isInternationalPath(page.pathname)
    && isInternationalPath(target.pathname);
}

export function makeResult(id, label, status, details = "", suggestionOverride = "") {
  const guidance = CHECK_GUIDANCE[id] || {};
  return {
    id,
    label,
    section: guidance.section || "Other",
    scope: guidance.scope || "section#MainSection only",
    status,
    details,
    suggestion: suggestionOverride || guidance.suggestion || "Review and correct the reported issue."
  };
}
