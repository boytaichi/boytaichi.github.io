// prospereum.io — the ONE definition of the site header nav and footer (sheet v2 row 6 footer sentence, verbatim).
// `scripts/stamp-chrome.mjs` writes these into every page's <nav>…</nav> and <footer>…</footer>; the check in
// `test/site.test.mjs` fails when a page drifts. Edit here, run `node scripts/stamp-chrome.mjs`, never edit a page's nav by hand.

/** Nav entries in display order: [href, label]. Six pages (Site Copy & IA v1 §1; About = "What PSRE is", Protocol = "How you earn it"). */
export const NAV = [
  ["/", "Overview"],
  ["/token/", "Token"],
  ["/partners/", "Partners &amp; Developers"],
  ["/use/", "Where you can use it"],
  ["/protocol/", "Protocol"],
  ["/about/", "About"],
];

/** Footer sentence, verbatim (Site Decision Sheet v2 row 6). */
export const FOOTER_SENTENCE =
  "PSRE is a utility token used within the Prospereum protocol. This site is for informational purposes only and does not constitute financial or investment advice. Published by WealthHealth AI, Inc.";

/** Page directory (relative to pages/) → its nav href. */
export const PAGES = {
  ".": "/",
  token: "/token/",
  partners: "/partners/",
  use: "/use/",
  protocol: "/protocol/",
  about: "/about/",
};

export function navHtml(currentHref) {
  const links = NAV.map(([href, label]) => (href === currentHref ? `<a href="${href}" aria-current="page">${label}</a>` : `<a href="${href}">${label}</a>`)).join("");
  return `<nav>${links}</nav>`;
}

export function footerHtml() {
  return `<footer>\n<p>${FOOTER_SENTENCE}</p>\n</footer>`;
}

/** Replace the first <nav>…</nav> and the <footer>…</footer> of a page; returns the new source (unchanged if already stamped). */
export function stamp(html, currentHref) {
  const withNav = html.replace(/<nav>[\s\S]*?<\/nav>/, navHtml(currentHref));
  return withNav.replace(/<footer>[\s\S]*?<\/footer>/, footerHtml());
}
