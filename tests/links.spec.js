import { test, expect } from '@playwright/test';

// Uses baseURL from the playwright.config.js shown in the conversation.
const INDEX_PAGE = '/index.html';
const NAVIGATION_TIMEOUT = 10_000;

function withoutHash(address) {
  const url = new URL(address);
  url.hash = '';
  return url.href;
}

// For this static site, / and /index.html are the same homepage.
function documentAddress(address) {
  const url = new URL(withoutHash(address));
  url.pathname = url.pathname.replace(/\/index\.html$/, '/');
  return url.href;
}

test('index links navigate to working pages', async ({ page, context }, testInfo) => {
  test.setTimeout(300_000);

  const indexResponse = await page.goto(INDEX_PAGE);
  expect(indexResponse?.ok(), 'The index page must return HTTP 2xx').toBeTruthy();
  const indexUrl = page.url();

  // Keep duplicates: two separate buttons linking to one page can behave differently.
  const links = await page.locator('a[href]').evaluateAll(anchors =>
    anchors.map((anchor, index) => ({
      index,
      href: anchor.getAttribute('href'),
      url: anchor.href,
      download: anchor.hasAttribute('download'),
      label: (anchor.getAttribute('aria-label') || anchor.textContent || anchor.href)
        .trim().replace(/\s+/g, ' ').slice(0, 100),
    }))
  );
  expect(links.length, 'The index page must contain links').toBeGreaterThan(0);

  const results = [];
  for (const link of links) {
    const description = `${link.label} -> ${link.url}`;
    let skipReason;
    if (link.download) skipReason = 'Download link';
    else if (!/^https?:/i.test(link.url)) skipReason = 'Non-web link (email, phone, JavaScript, etc.)';
    else if (documentAddress(link.url) === documentAddress(indexUrl)) {
      skipReason = 'Same-page link or section anchor';
    }

    if (skipReason) {
      results.push({ link: description, status: 'skipped', reason: skipReason });
      continue;
    }

    // Each click starts in a fresh tab on index.html.
    const source = await context.newPage();
    const popups = [];
    const responses = [];
    const collectResponse = response => {
      if (response.request().isNavigationRequest()) responses.push(response);
    };
    source.on('popup', popup => popups.push(popup));

    try {
      await test.step(description, async () => {
        const response = await source.goto(indexUrl);
        expect(response?.ok(), 'Could not reopen the index page').toBeTruthy();
        const anchor = source.locator('a[href]').nth(link.index);
        await expect(anchor).toHaveAttribute('href', link.href);

        if (!(await anchor.isVisible())) {
          results.push({ link: description, status: 'skipped', reason: 'Hidden link; open its menu in a separate test' });
          return;
        }

        // Register before clicking so fast navigations and popup responses are captured.
        context.on('response', collectResponse);
        const destinationPromise = Promise.race([
          source.waitForURL(url => url.href !== indexUrl, {
            waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT,
          }).then(() => source),
          source.waitForEvent('popup', { timeout: NAVIGATION_TIMEOUT }),
        ]);
        const [destination] = await Promise.all([
          destinationPromise,
          anchor.click({ timeout: NAVIGATION_TIMEOUT }),
        ]);
        await destination.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT });

        const documentResponses = responses
          .filter(item => item.frame() === destination.mainFrame());
        const documentResponse = documentResponses.at(-1);
        expect(documentResponse, 'Click must load an HTML document; this test is for static pages').toBeTruthy();
        expect(documentResponse.ok(), `${destination.url()} returned HTTP ${documentResponse.status()}`).toBeTruthy();
        expect(documentResponse.headers()['content-type'] || '', 'Destination must be an HTML page')
          .toMatch(/text\/html|application\/xhtml\+xml/i);

        // Login pages can redirect with JavaScript or HTML, starting a new HTTP chain.
        // Check where the entire navigation STARTED, not just the final redirect chain.
        let firstRequest = documentResponses[0].request();
        while (firstRequest.redirectedFrom()) {
          firstRequest = firstRequest.redirectedFrom();
        }
        expect(withoutHash(firstRequest.url()), 'Navigation must start at the link href')
          .toBe(withoutHash(link.url));
        expect(documentAddress(destination.url()), 'Link must leave the index page')
          .not.toBe(documentAddress(indexUrl));
        await expect(destination.locator('body')).toBeVisible();

        results.push({ link: description, status: 'passed', destination: destination.url() });
      });
    } catch (error) {
      results.push({ link: description, status: 'failed', reason: error.message });
    } finally {
      context.off('response', collectResponse);
      await Promise.all([...popups, source].map(tab => tab.close().catch(() => {})));
    }
  }

  await testInfo.attach('link-results.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });
  for (const result of results) {
    console.log(`[${result.status}] ${result.link}${result.reason ? `: ${result.reason}` : ''}`);
  }
  const failures = results.filter(result => result.status === 'failed');
  expect(failures, 'Broken links — see link-results.json in the test report').toEqual([]);
  expect(results.filter(result => result.status === 'passed').length,
    'At least one visible link must navigate to another page').toBeGreaterThan(0);
});
